/**
 * BM25 索引的行为测试：相关度排序、keys 字段加权（不计入文档长度）、时间衰减、索引维护与确定性；
 * 在库里单独成词过的字作为半权重的单字词，功能字不参与，只是构词成分的字只给已有命中加分，
 * 单字 key 与纯单字查询例外；查询里的中英文功能词不参与评分；强调片段按命中分加权；
 * 以及写入去重用的相似度——相同正文为 1、不同事实远低于阈值，且同一对文本的得分不随库规模漂移。
 */
import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'

interface Memory {
  title: string
}

/** 构造 4 条中文记忆：m1 高频命中「魔法/符文」，m3 仅一次「魔法」，m2/m4 不相关。 */
function makeIndex(): Bm25Index<Memory> {
  const index = new Bm25Index<Memory>()
  index.add({ id: 'm1', text: '艾琳在魔法塔里研究古代魔法符文，每天都练习魔法', data: { title: '魔法研究' } })
  index.add({ id: 'm2', text: '港口酒馆里流传着幽灵船与水手的传说', data: { title: '酒馆传闻' } })
  index.add({ id: 'm3', text: '魔法学院今年举办炼金术大赛', data: { title: '学院赛事' } })
  index.add({ id: 'm4', text: '艾琳的黑猫喜欢在窗台晒太阳', data: { title: '日常琐事' } })
  return index
}

describe('Bm25Index 相关度排序', () => {
  it('query 命中排序：高频文档在前，无命中文档不出现', () => {
    const hits = makeIndex().search('魔法')
    expect(hits.map(h => h.id)).toEqual(['m1', 'm3'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    // data 透传
    expect(hits[0]!.data).toEqual({ title: '魔法研究' })
  })

  it('多 term 查询：同时命中「符文」的文档进一步领先', () => {
    const hits = makeIndex().search('魔法符文')
    expect(hits.map(h => h.id)).toEqual(['m1', 'm3'])
  })

  it('直接搜一个字时返回含这个字的文档，功能字除外', () => {
    expect(makeIndex().search('魔').map(h => h.id)).toEqual(['m1', 'm3'])
    expect(makeIndex().search('的')).toEqual([])
  })
})

describe('单字词', () => {
  /** 10 条记忆：凛、樱在句首或被虚词、标点夹住，是单独成词的用法；药只出现在「取药、火药」里，钥只出现在「钥匙」里。 */
  function makeStory(): Bm25Index {
    const index = new Bm25Index()
    const bodies: Record<string, string> = {
      a: '凛是独来独往的佣兵',
      b: '凛的妹妹叫樱，在旧图书馆做抄写员',
      c: '樱每个月初七要去教堂后院取药',
      d: '艾琳把银怀表押给了黑礁酒馆的老乔',
      e: '罗兰是巡夜队的队长',
      f: '码头仓库里囤积着火药',
      g: '灯塔的看守人是个哑巴老人',
      h: '集市的鱼摊老板娘知道地下水道的近路',
      i: '翡翠钥匙藏在钟楼顶层',
      j: '伯爵府地窖的钥匙由管家保管',
    }
    for (const [id, text] of Object.entries(bodies)) index.add({ id, text })
    return index
  }
  const ids = (index: Bm25Index, query: string): string[] => index.search(query, { topK: 100 }).map(h => h.id)
  const scoreOf = (index: Bm25Index, query: string, id: string): number =>
    index.search(query, { topK: 100 }).find(h => h.id === id)?.score ?? 0

  it('库里单独成词过的字，在问句里也能命中', () => {
    const index = makeStory()
    // 「凛去哪了」与「凛是」「凛的」没有共同 bigram；去、哪、了是功能字
    expect(ids(index, '凛去哪了').sort()).toEqual(['a', 'b'])
    // 只出现过一次，但「叫樱，」两侧是虚词和标点
    expect(ids(index, '樱最近好吗').sort()).toEqual(['b', 'c'])
    expect(ids(index, '这件事要告诉凛吗').sort()).toEqual(['a', 'b'])
  })

  it('只是构词成分的字不单独带出命中，但给已有命中加分', () => {
    const index = makeStory()
    // 「药」在库里只出现在「取药」「火药」里：单问药找不到，火药那条也不会被「樱的药」带出来
    expect(ids(index, '药还够吗')).toEqual([])
    expect(ids(index, '樱的药还够吗').sort()).toEqual(['b', 'c'])
    expect(ids(index, '樱的药还够吗')[0]).toBe('c')
    // 同时提到樱和取药的那条因为「药」多得了分，只提到樱的那条不变
    expect(scoreOf(index, '樱的药还够吗', 'c')).toBeGreaterThan(scoreOf(index, '樱还好吗', 'c'))
    expect(scoreOf(index, '樱的药还够吗', 'b')).toBeCloseTo(scoreOf(index, '樱还好吗', 'b'), 9)
    // 「钥」右边永远是「匙」，「翡」只出现过一次：既不带出命中，也不算能产的构词成分
    expect(ids(index, '锁钥在握')).toEqual([])
    expect(ids(index, '翡色的光')).toEqual([])
  })

  it('问句里夹在别的实字中间的字不算：库里的「礁门自开」不让「几点开始」命中', () => {
    const index = makeStory()
    index.add({ id: 'gate', text: '潮退之时，礁门自开' })
    // 「开」在库里被虚词和句末夹住，是单独成词的用法
    expect(ids(index, '门开了吗')).toEqual(['gate'])
    // 「开始」里的「开」两侧都是实字
    expect(ids(index, '电影几点开始放')).toEqual([])
  })

  it('直接搜一个或几个孤立的字时，用户要的就是这些字', () => {
    const index = makeStory()
    expect(ids(index, '药').sort()).toEqual(['c', 'f'])
    expect(ids(index, '钥').sort()).toEqual(['i', 'j'])
    expect(ids(index, '翡')).toEqual(['i'])
    expect(ids(index, '樱 药').sort()).toEqual(['b', 'c', 'f'])
  })

  it('功能字不作为单字词，查询里的功能 bigram 也不参与', () => {
    const index = makeStory()
    index.add({ id: 'k', text: '他被认了出来，但没有声张' })
    // 「的」出现在大半文档里；「没有」是两个功能字
    expect(ids(index, '的')).toEqual([])
    expect(ids(index, '没有')).toEqual([])
    expect(ids(index, '没有，你继续说。')).toEqual([])
    // 「老」只出现在老乔、老人、老板娘里，没有单独成词过
    expect(ids(index, '古老的传说')).toEqual([])
    expect(ids(index, '周末打算去爬山')).toEqual([])
  })

  it('引出名字的字后面跟一个字再跟标点，那个字算单独成词', () => {
    const index = makeStory()
    index.add({ id: 'whale', text: '码头的搬运工头领绰号鲸，只听女伯爵的吩咐' })
    index.add({ id: 'qin', text: '诺瓦的师傅姓秦。' })
    expect(ids(index, '鲸听谁的')).toEqual(['whale'])
    expect(ids(index, '秦师傅回来了吗')).toEqual(['qin'])
  })

  it('单字 key 把这个字声明为词：功能字、没有单独成词过的字也能检索，并按关键词加权', () => {
    const index = makeStory()
    // 「七」是数词，在功能字表里；c 里的「初七」不是名字
    expect(ids(index, '七后来找到了吗')).toEqual([])
    index.add({ id: 'seven', text: '他是凛早年的搭档，三年前在南方失踪', keys: ['七'] })
    expect(ids(index, '七后来找到了吗')[0]).toBe('seven')
    expect(ids(index, '七后来找到了吗')).toContain('c')
    // 多字 key 不声明其中的单字
    index.add({ id: 'pair', text: '两人约在渡口见面', keys: ['九月'] })
    expect(ids(index, '九怎么还没到')).toEqual([])
    // 撤掉声明它的文档后恢复原状
    index.remove('seven')
    expect(ids(index, '七后来找到了吗')).toEqual([])
  })

  it('出现在超过半数文档里的字没有区分度，直接搜或被 key 声明时仍可用', () => {
    const index = new Bm25Index()
    const places = ['窗台', '值班室', '钟楼', '码头', '厨房', '阁楼', '花园', '书房', '走廊', '屋顶', '地窖', '马厩', '门廊']
    // 24 条里 13 条含「雪」
    places.forEach((place, i) => index.add({ id: `s${i}`, text: `雪在${place}睡着了` }))
    places.slice(0, 11).forEach((place, i) => index.add({ id: `o${i}`, text: `${place}的灯坏了很久` }))
    expect(index.size).toBe(24)
    expect(index.search('雪今天吃东西了吗')).toEqual([])
    expect(index.search('雪', { topK: 100 })).toHaveLength(13)
    index.add({ id: 'cat', text: '白猫是艾琳捡来的', keys: ['雪'] })
    const hits = index.search('雪今天吃东西了吗', { topK: 100 }).map(h => h.id)
    expect(hits).toHaveLength(14)
    expect(hits[0]).toBe('cat')
  })

  it('库里只有几条记忆时不按比例排除：主角的名字出现在大半条里也能检索', () => {
    const index = new Bm25Index()
    index.add({ id: 'only', text: '樱是凛的妹妹，住在北街。' })
    // 只有一条记忆时每个字都出现在全部文档里
    expect(index.search('樱在哪').map(h => h.id)).toEqual(['only'])
    expect(index.search('凛呢').map(h => h.id)).toEqual(['only'])
    index.add({ id: 'dark', text: '樱怕黑，夜里要点灯。' })
    index.add({ id: 'dock', text: '凛在码头做工。' })
    // 3 条里 2 条含「樱」
    expect(index.search('樱今天还好吗').map(h => h.id).sort()).toEqual(['dark', 'only'])
    expect(index.search('凛呢').map(h => h.id).sort()).toEqual(['dock', 'only'])
    // 功能字仍然不用
    expect(index.search('在哪')).toEqual([])
  })

  it('查询只有孤立的单字时，名字在库里一处开头、另一处收尾即可', () => {
    const index = makeStory()
    // 「豆」从没被两侧同时夹住：一处在句首接实字，一处后面是虚词，一处是「豆子」
    index.add({ id: 'stray', text: '流浪猫豆是随补给船偷渡上来的' })
    index.add({ id: 'scratch', text: '豆抓伤过值班的医生' })
    index.add({ id: 'bean', text: '温室里种的豆子熟了' })
    expect(ids(index, '豆在哪').sort()).toEqual(['bean', 'scratch', 'stray'])
    expect(ids(index, '豆呢？').sort()).toEqual(['bean', 'scratch', 'stray'])
    // 查询里还有别的实词时不放宽：没有命中就是没有
    expect(ids(index, '豆今天吃东西了吗')).toEqual([])
    // 只在一侧有过边界的字不算：「走私」开头，但没有以「走」收尾的地方
    index.add({ id: 'smuggler', text: '走私贩子每个月随船来一趟' })
    expect(ids(index, '我走了')).toEqual([])
    expect(ids(index, '走吧')).toEqual([])
  })

  it('假名单字不作为单字词', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '猫が窓にいる' })
    index.add({ id: 'b', text: '犬が庭にいる' })
    index.add({ id: 'c', text: '鳥は空を飛ぶ' })
    expect(index.search('が')).toEqual([])
    expect(index.search('猫').map(h => h.id)).toEqual(['a'])
  })

  it('删除与覆盖同步更新单字倒排和成词判断', () => {
    const index = makeStory()
    expect(ids(index, '樱最近好吗').sort()).toEqual(['b', 'c'])
    index.remove('b')
    index.remove('c')
    expect(ids(index, '樱最近好吗')).toEqual([])
    // 「樱花」里的樱不是单独成词的用法
    index.add({ id: 'z', text: '院子里的樱花开了' })
    expect(ids(index, '樱最近好吗')).toEqual([])
    expect(ids(index, '樱')).toEqual(['z'])
    // 同 id 覆盖成单独成词的用法
    index.add({ id: 'z', text: '旧图书馆的樱在抄书' })
    expect(ids(index, '樱最近好吗')).toEqual(['z'])
    index.clear()
    expect(ids(index, '樱')).toEqual([])
  })

  it('整词文字不受影响：英文仍按整词匹配', () => {
    const index = new Bm25Index()
    for (const [id, text] of Object.entries({ a: 'the harbor master', b: 'a broken sword', c: 'old lighthouse keeper', d: 'north gate at night' })) {
      index.add({ id, text })
    }
    expect(index.search('harbor').map(h => h.id)).toEqual(['a'])
    expect(index.search('h')).toEqual([])
  })
})

describe('英文功能词', () => {
  function makeInn(): Bm25Index {
    const index = new Bm25Index()
    const bodies: Record<string, string> = {
      key: 'Mara keeps the brass key in a hollow book',
      debt: 'The mayor owes Old Finn forty silver and has not paid',
      rooms: 'The Anchor Inn has no rooms on the night of the fair',
      will: 'Old Finn does not trust the ferryman',
    }
    for (const [id, text] of Object.entries(bodies)) index.add({ id, text })
    return index
  }

  it('只由功能词组成的句子没有命中，内容词照常匹配', () => {
    const index = makeInn()
    expect(index.search('No, it is not on the house.')).toEqual([])
    expect(index.search('What a lovely morning it is.')).toEqual([])
    expect(index.search('where is the brass key').map(h => h.id)).toEqual(['key'])
  })

  it('功能词被单独写成 key 后照常参与：名字正好是功能词', () => {
    const index = makeInn()
    index.add({ id: 'an', text: 'An mends nets by the pier' })
    expect(index.search('Has An been in?')).toEqual([])
    index.add({ id: 'smith', text: 'The smith left town after the fire', keys: ['An'] })
    expect(index.search('Has An been in?').map(h => h.id).sort()).toEqual(['an', 'smith'])
  })

  it('以单个字母为名的角色能检索，带撇号的缩写不带来命中', () => {
    const index = makeInn()
    index.add({ id: 'm', text: "M keeps the ledger in the cellar; it's never left Mara's sight" })
    index.add({ id: 's', text: '小S偷走了账本，T先生还不知道' })
    expect(index.search('Where is M?').map(h => h.id)).toEqual(['m'])
    expect(index.search('小S去哪了').map(h => h.id)).toEqual(['s'])
    expect(index.search('T先生知道吗')[0]?.id).toBe('s')
    // it's、don't、I'm 的词尾不是词：不因为库里有所有格和 M、T、S 就命中
    expect(index.search("It's fine, don't worry. I'm sure that's it.")).toEqual([])
  })

  it('will、may 同时是常见人名，不当作功能词', () => {
    const index = makeInn()
    index.add({ id: 'stair', text: 'Will keeps the spare key under the third stair' })
    index.add({ id: 'coins', text: 'May owes the innkeeper two silver coins' })
    expect(index.search('Where is Will?').map(h => h.id)).toEqual(['stair'])
    expect(index.search('What does May owe?').map(h => h.id)).toEqual(['coins'])
  })
})

describe('别名、查询给出的名字与按字面检索', () => {
  function makeStation(): Bm25Index {
    const index = new Bm25Index()
    const bodies: Record<string, string> = {
      pills: '医务室的止痛剂上个月少了两箱，值班记录被人改过',
      seven: '他是凛早年的搭档，三年前在南方失踪',
      day: '七天后补给船才会到',
      gate: '北门每晚亥时落锁',
      tower: '灯塔的看守人是个哑巴老人',
      market: '集市的鱼摊只收铜板',
    }
    for (const [id, text] of Object.entries(bodies)) index.add({ id, text })
    return index
  }

  it('别名让换了说法的问法找到记忆：与 keys 一样匹配，但按正文的词频计', () => {
    const index = makeStation()
    expect(index.search('谁在偷药')).toEqual([])
    index.add({ id: 'pills', text: '医务室的止痛剂上个月少了两箱，值班记录被人改过', aliases: ['药', '药品', '失窃', '偷药'] })
    expect(index.search('谁在偷药').map(h => h.id)).toEqual(['pills'])
    expect(index.search('药品失窃是怎么回事')[0]?.id).toBe('pills')
    // 同一个词写成 key 得分更高：别名是推测，按 1 倍词频
    const asAlias = index.search('失窃')[0]!.score
    index.add({ id: 'pills', text: '医务室的止痛剂上个月少了两箱，值班记录被人改过', keys: ['失窃'] })
    expect(index.search('失窃')[0]!.score).toBeGreaterThan(asAlias)
    // 覆盖时不带别名：旧别名不残留
    index.add({ id: 'pills', text: '医务室的止痛剂上个月少了两箱，值班记录被人改过' })
    expect(index.search('谁在偷药')).toEqual([])
  })

  it('只有一个字的别名把它声明为词，功能字也一样；别名不计入文档长度', () => {
    const index = makeStation()
    expect(index.search('七后来找到了吗')).toEqual([])
    index.add({ id: 'seven', text: '他是凛早年的搭档，三年前在南方失踪', aliases: ['七'] })
    // 「七天后」那条正文里本来就有这个字，现在一并命中
    expect(index.search('七后来找到了吗').map(h => h.id).sort()).toEqual(['day', 'seven'])
    // 正文命中的得分不因别名多而下降（这些别名与查询没有共同的字词）
    const before = index.search('南方失踪')[0]!.score
    index.add({ id: 'seven', text: '他是凛早年的搭档，三年前在南方失踪', aliases: ['七', '下落不明', '旧识', '老朋友', '多年没有音讯'] })
    expect(index.search('南方失踪')[0]!.score).toBeCloseTo(before, 9)
  })

  it('查询给出的名字当作已声明的词，只对这一次查询有效', () => {
    const index = makeStation()
    index.add({ id: 'cat', text: '七昨晚没有回来' })
    index.add({ id: 'hinata', text: '日向在练剑' })
    // 「七」是数词：不声明时不作单字词
    expect(index.search('七后来怎么样了')).toEqual([])
    expect(index.search('七后来怎么样了', { names: ['七'] }).map(h => h.id).sort()).toEqual(['cat', 'day'])
    expect(index.search('七后来怎么样了')).toEqual([])
    // 两个功能字组成的名字：声明后按全权重
    const half = index.search('日向')[0]!.score
    expect(index.search('日向', { names: ['日向'] })[0]!.score).toBeCloseTo(half * 2, 9)
    // 带间隔号的名字每一段各自声明；多于一个词的段不声明任何东西
    expect(index.search('七呢', { names: ['艾琳·七'] }).map(h => h.id).sort()).toEqual(['cat', 'day'])
    expect(index.search('七后来怎么样了', { names: ['七海凛'] })).toEqual([])
    // 人设名叫「我」、默认名是功能词时不声明
    index.add({ id: 'me', text: '我把钥匙交给了守卫' })
    expect(index.search('我后来怎么样了', { names: ['我', 'You', '我们'] })).toEqual([])
  })

  it('明确给出的检索词只有孤立的单字时按字面匹配，功能字也不例外；带着别的词时照常', () => {
    const index = makeStation()
    index.add({ id: 'cat', text: '七昨晚没有回来' })
    expect(index.search('七')).toEqual([])
    expect(index.search('七', { explicit: true }).map(h => h.id).sort()).toEqual(['cat', 'day'])
    expect(index.search('七 凛', { explicit: true }).map(h => h.id).sort()).toEqual(['cat', 'day', 'seven'])
    // 不是纯单字查询：功能字仍不作单字词
    expect(index.search('七后来怎么样了', { explicit: true })).toEqual([])
    // 库里没有的字照样没有结果
    expect(index.search('鲸', { explicit: true })).toEqual([])
  })
})

describe('由功能字组成的名字和实词', () => {
  const bodies = ['日向是剑道部的主将。', '和也欠了房东三个月房租。', '五月把钥匙藏在花盆底下。', '天使像前的蜡烛每晚都有人点。', '知府大人收了盐商的银子。',
    '小月怕打雷。', '千里在码头当搬运工。', '上将下令封锁港口。', '镇上的人都说他是天才。', '她一直向往自由。', '不二把赌来的钱都给了妹妹。', '那月每天清晨去河边练琴。',
    '城外的铁匠和这件事无关。', '渡口的船夫只收铜板。', '三上欠酒馆老板一坛酒。', '天下第一的铸剑师住在北山。', '十三号仓库的钥匙在老周手里。', '大和号停在三号码头。',
    '自然教室的窗户坏了很久。', '九条家的后院有一口枯井。']
  function makeTown(): Bm25Index {
    const index = new Bm25Index()
    bodies.forEach((text, i) => index.add({ id: String(i + 1), text }))
    return index
  }

  it('名字和实词即使两个字都在功能字表里也能检索，不需要写进 keys', () => {
    const index = makeTown()
    const cases: Array<[string, number]> = [['日向在哪', 1], ['日向', 1], ['和也欠了谁的钱', 2], ['和也', 2], ['五月', 3], ['五月藏了什么', 3], ['天使像', 4], ['天使', 4],
      ['大人收了什么', 5], ['大人', 5], ['小月怕什么', 6], ['小月', 6], ['千里', 7], ['千里在做什么', 7], ['上将', 8], ['上将下了什么命令', 8], ['天才', 9], ['自由', 10],
      ['不二', 11], ['不二的钱呢', 11], ['那月', 12], ['那月在哪练琴', 12], ['三上', 15], ['三上欠了什么', 15], ['天下第一', 16], ['十三号仓库', 17], ['大和号', 18], ['大和', 18],
      ['自然教室', 19], ['九条', 20], ['九条家', 20]]
    for (const [query, id] of cases) expect(index.search(query)[0]?.id, query).toBe(String(id))
  })

  it('两个功能字组成的 bigram 按半权重计，被 key 声明后按全权重', () => {
    const index = new Bm25Index()
    // 两条正文结构相同，只有名字不同；其余几条让文档频率有意义
    index.add({ id: 'hinata', text: '日向在练剑' })
    index.add({ id: 'erin', text: '艾琳在练剑' })
    for (const [id, text] of [['a', '北门每晚落锁'], ['b', '灯塔的看守是哑巴'], ['c', '集市的鱼摊收铜板']] as const) index.add({ id, text })
    const score = (query: string, id: string): number => index.search(query).find(h => h.id === id)?.score ?? 0
    expect(score('艾琳', 'erin')).toBeGreaterThan(0)
    expect(score('日向', 'hinata')).toBeCloseTo(score('艾琳', 'erin') * 0.5, 9)
    // 名字写进 keys：既按关键词加权，也不再减半
    index.add({ id: 'hinata', text: '日向在练剑', keys: ['日向'] })
    index.add({ id: 'erin', text: '艾琳在练剑', keys: ['艾琳'] })
    expect(score('日向', 'hinata')).toBeCloseTo(score('艾琳', 'erin'), 9)
  })

  it('真正的功能词仍不参与：列表里的词、相邻的核心虚词、助词挨着功能字、数词接量词', () => {
    const index = makeTown()
    index.add({ id: 'noise', text: '他们没有说什么，我们也不知道那个人起来之后去了哪里，两个月里来过三次。' })
    for (const query of ['没有', '我们', '什么', '他们', '也不', '知道', '那个', '起来', '之后', '哪里', '两个', '三次', '个月', '的人', '了吗',
      '我们没有什么可以说的', '你知道他们现在在哪里吗', '然后呢？']) {
      expect(index.search(query), query).toEqual([])
    }
  })
})

describe('强调片段', () => {
  function makeScene(): Bm25Index {
    const index = new Bm25Index()
    const bodies: Record<string, string> = {
      bar: '老乔在黑礁酒馆的吧台后面擦杯子',
      game: '黑礁酒馆每逢十五有地下赌局',
      debt: '塞巴斯欠了老乔一大笔赌债',
      key: '翡翠钥匙藏在钟楼顶层的砖后面',
      quiet: '他被认了出来，但没有声张',
      gate: '北门每晚亥时落锁',
      tower: '灯塔的看守人是个哑巴老人',
      market: '集市的鱼摊老板娘知道地下水道的近路',
    }
    for (const [id, text] of Object.entries(bodies)) index.add({ id, text })
    return index
  }
  const scene = '黑礁酒馆里烟气缭绕，老乔一边擦杯子一边盯着赌局，塞巴斯又欠下一笔赌债。'

  it('最新输入里的词加权后，只在这句里命中的条目升到最前', () => {
    const index = makeScene()
    const input = '对了，翡翠钥匙你放在哪儿了？'
    const query = [scene, input].join('\n')
    const plain = index.search(query)
    expect(plain[0]!.id).not.toBe('key')
    const boosted = index.search(query, { boost: { query: input, weight: 3 } })
    expect(boosted[0]!.id).toBe('key')
    // 场景里的条目仍在结果中，只是让出了首位
    expect(boosted.map(h => h.id)).toEqual(expect.arrayContaining(['bar', 'game', 'debt']))
  })

  it('加权是按命中分相加：结果等于主查询得分加上片段得分的 weight 倍', () => {
    // 用整词文字验证相加关系：单字词的主次证据取决于同一次查询里的其它命中，不满足逐项相加
    const index = new Bm25Index()
    const bodies: Record<string, string> = {
      bar: 'Old Finn wipes mugs behind the bar of the Anchor Inn',
      game: 'The Anchor Inn hosts a dice game on the fifteenth',
      debt: 'Sebas owes Old Finn a large gambling debt',
      key: 'The jade key is hidden behind a brick in the clock tower',
      gate: 'The north gate is locked every night',
    }
    for (const [id, text] of Object.entries(bodies)) index.add({ id, text })
    const context = 'Smoke hung over the Anchor Inn while Old Finn watched the dice game and Sebas ran up another debt.'
    const input = 'Does the jade key have anything to do with the debt?'
    const main = new Map(index.search(context, { topK: 100 }).map(h => [h.id, h.score]))
    const extra = new Map(index.search(input, { topK: 100 }).map(h => [h.id, h.score]))
    const boosted = index.search(context, { topK: 100, boost: { query: input, weight: 2 } })
    expect(boosted.length).toBe(new Set([...main.keys(), ...extra.keys()]).size)
    expect(extra.has('key')).toBe(true)
    for (const hit of boosted) {
      expect(hit.score).toBeCloseTo((main.get(hit.id) ?? 0) + 2 * (extra.get(hit.id) ?? 0), 9)
    }
  })

  it('闲聊输入里的功能词不带来加分；偶然撞上的内容词只按自身分数加权', () => {
    const index = makeScene()
    const question = '对了，翡翠钥匙你放在哪儿了？'
    const run = (input: string) => index.search([scene, input].join('\n'), { topK: 100, boost: { query: input, weight: 3 } })
    const plain = (input: string) => index.search([scene, input].join('\n'), { topK: 100 })
    const score = (hits: ReturnType<typeof run>, id: string): number => hits.find(h => h.id === id)?.score ?? 0
    // 「没有声张」只和「没有，你继续说。」共有功能词「没有」：加不加权结果都一样
    expect(run('没有，你继续说。')).toEqual(plain('没有，你继续说。'))
    expect(score(run('没有，你继续说。'), 'quiet')).toBe(0)
    // 「声张」是内容词：加权后有所上升，但首位仍是场景里的条目
    const chat = '别声张，你继续说。'
    expect(score(run(chat), 'quiet')).toBeGreaterThan(score(plain(chat), 'quiet'))
    expect(run(chat)[0]!.id).toBe(plain(chat)[0]!.id)
    expect(run(chat)[0]!.id).not.toBe('quiet')
    // 同样的权重下，真正问到的条目得到的加分多于偶然撞上的
    const gained = score(run(question), 'key') - score(plain(question), 'key')
    expect(gained).toBeGreaterThan(score(run(chat), 'quiet') - score(plain(chat), 'quiet'))
  })

  it('权重非正、非有限或片段为空时与不加权完全相同', () => {
    const index = makeScene()
    const query = [scene, '翡翠钥匙你放在哪儿了'].join('\n')
    const plain = index.search(query)
    for (const boost of [{ query: '翡翠钥匙', weight: 0 }, { query: '翡翠钥匙', weight: -1 }, { query: '翡翠钥匙', weight: Number.NaN },
      { query: '翡翠钥匙', weight: Infinity }, { query: '', weight: 3 }, { query: ' ，。 ', weight: 3 }]) {
      expect(index.search(query, { boost })).toEqual(plain)
    }
  })

  it('片段与主查询相同时全体等比放大，排序不变', () => {
    const index = makeScene()
    const plain = index.search(scene, { topK: 100 })
    const boosted = index.search(scene, { topK: 100, boost: { query: scene, weight: 3 } })
    expect(boosted.map(h => h.id)).toEqual(plain.map(h => h.id))
    boosted.forEach((hit, i) => expect(hit.score).toBeCloseTo(plain[i]!.score * 4, 9))
  })

  it('时间衰减作用在加权后的总分上', () => {
    const index = new Bm25Index()
    const now = 1_000_000_000
    index.add({ id: 'new', text: '翡翠钥匙藏在钟楼', ts: now })
    index.add({ id: 'old', text: '翡翠钥匙藏在钟楼', ts: now - 1000 })
    const hits = index.search('钟楼 翡翠钥匙', { now, halfLifeMs: 1000, boost: { query: '翡翠钥匙', weight: 3 } })
    expect(hits.map(h => h.id)).toEqual(['new', 'old'])
    expect(hits[1]!.score).toBeCloseTo(hits[0]!.score * 0.5, 9)
  })
})

describe('keys 加权', () => {
  it('相同文本下带 keys 的文档排名更高', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '酒馆里流传着幽灵船的传说' })
    index.add({ id: 'b', text: '酒馆里流传着幽灵船的传说', keys: ['幽灵船'] })
    const hits = index.search('幽灵船')
    expect(hits.map(h => h.id)).toEqual(['b', 'a'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('只写在 keys 里的词比正文里出现一次的词得分更高', () => {
    const index = new Bm25Index()
    index.add({ id: 'body', text: '她把幽灵船的事告诉了船长' })
    index.add({ id: 'key', text: '她把那艘船的事告诉了船长', keys: ['幽灵船'] })
    index.add({ id: 'other', text: '港口的面包涨价了两个铜板' })
    expect(index.search('幽灵船').map(h => h.id)).toEqual(['key', 'body'])
  })

  it('keys 不计入文档长度：合并了大量 keys 的条目不会在正文词上被压到同分以下', () => {
    const index = new Bm25Index()
    const manyKeys = ['艾琳', '莉莉丝', '罗兰', '塞巴斯', '维多利亚', '白石', '千夏', '诺瓦', '北门', '魔法塔', '港口酒馆', '王都', '地下墓穴', '学院']
    index.add({ id: 'few', text: '艾琳在北门答应保守秘密', keys: ['艾琳'] })
    index.add({ id: 'many', text: '艾琳在北门答应保守秘密', keys: manyKeys })
    index.add({ id: 'weak', text: '罗兰在集市上听说有人要保守秘密，但他并不在意这些传闻，转身就走了' })
    const hits = index.search('保守秘密')
    const score = (id: string): number => hits.find(h => h.id === id)!.score
    // 查询词只出现在正文里，两条正文相同的条目应同分，且都高于只顺带提到的长条目
    expect(score('many')).toBe(score('few'))
    expect(score('many')).toBeGreaterThan(score('weak'))
  })

  it('全库只有 keys、没有正文时仍给出有限分数', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '', keys: ['幽灵船'] })
    index.add({ id: 'b', text: '', keys: ['灯塔'] })
    const hits = index.search('幽灵船')
    expect(hits.map(h => h.id)).toEqual(['a'])
    expect(Number.isFinite(hits[0]!.score)).toBe(true)
    expect(hits[0]!.score).toBeGreaterThan(0)
  })
})

describe('写入去重相似度', () => {
  const fillers = ['港口的面包涨价了两个铜板', '学院今年举办炼金术大赛', '黑猫喜欢在窗台晒太阳', '守卫在午夜换岗',
    '旅店地窖藏着走私火药', '河岸的渡船明晨开航', '铁匠铺收了一个新学徒', '温室里的月光花开了']
  /** 已有条目外加 size - 1 条无关记忆；无关条目带序号，保证各不相同。 */
  function indexOf(existing: string, size: number): Bm25Index {
    const index = new Bm25Index()
    index.add({ id: 'base', text: existing })
    for (let i = 1; i < size; i++) index.add({ id: `m${i}`, text: `${fillers[i % fillers.length]}，这是第${i}件琐事` })
    return index
  }
  const scoreOf = (index: Bm25Index, text: string): number =>
    index.similarity(text, { topK: 1000 }).find(h => h.id === 'base')?.score ?? 0
  const existing = '诺瓦在钟楼修好了断剑，代价是三枚金币。'

  it.each([1, 5, 30, 200])('库规模 %i：相同正文恰好为 1，标点差异不影响', (size) => {
    const index = indexOf(existing, size)
    expect(scoreOf(index, existing)).toBe(1)
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑 代价是三枚金币')).toBe(1)
  })

  it.each([1, 5, 30, 200])('库规模 %i：近似重复高于默认阈值，不同事实低于默认阈值', (size) => {
    const index = indexOf(existing, size)
    const threshold = 0.75
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑，代价是五枚金币。')).toBeGreaterThanOrEqual(threshold)
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑，代价是三枚金币，她很满意。')).toBeGreaterThanOrEqual(threshold)
    // 同人同地的另一件事：旧的 BM25 绝对分在各规模下都把它判成重复
    expect(scoreOf(index, '诺瓦在钟楼捡到一张从没见过的旧地图，决定先瞒着所有人。')).toBeLessThan(0.3)
    expect(scoreOf(index, '诺瓦其实是北境流亡贵族的后裔，这件事还没人知道。')).toBeLessThan(0.1)
    expect(scoreOf(index, '城里新开的裁缝店每天清晨排起长队')).toBe(0)
  })

  it('同一对文本的得分不随库规模漂移', () => {
    const variant = '诺瓦在钟楼修好了断剑，代价是五枚金币。'
    const scores = [1, 5, 30, 200].map(size => scoreOf(indexOf(existing, size), variant))
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(0.02)
  })

  it('长名字加短事件的不同事实仍低于默认阈值', () => {
    for (const size of [1, 30, 200]) {
      expect(scoreOf(indexOf('维多利亚在港口酒馆喝醉了', size), '维多利亚在港口酒馆赢了一局牌')).toBeLessThan(0.75)
    }
  })

  it('双向取小：只是长条目的一小部分，或把短条目扩写成长事实，都不算相同', () => {
    const long = '诺瓦在钟楼修好了断剑，代价是三枚金币，随后她把剑交给了守夜人，并约定月底之前取回。'
    expect(scoreOf(indexOf(long, 30), '诺瓦在钟楼修好了断剑')).toBeLessThan(0.5)
    expect(scoreOf(indexOf('诺瓦在钟楼修好了断剑', 30), long)).toBeLessThan(0.5)
  })

  it('keys 参与比较但不重复加权；结果按分数降序、同分按 id，并遵守 topK', () => {
    const index = new Bm25Index<string>()
    index.add({ id: 'b', text: '幽灵船停在港口', keys: ['幽灵船', '幽灵船'], data: 'B' })
    index.add({ id: 'a', text: '幽灵船停在港口', keys: ['幽灵船'], data: 'A' })
    index.add({ id: 'c', text: '幽灵船停在港口，船长已经失踪三天' })
    const hits = index.similarity('幽灵船停在港口')
    expect(hits.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(hits[0]).toEqual({ id: 'a', score: 1, data: 'A' })
    expect(hits[1]!.score).toBe(1)
    expect(hits[2]!.score).toBeLessThan(1)
    expect(index.similarity('幽灵船停在港口', { topK: 1 }).map(h => h.id)).toEqual(['a'])
    expect(index.similarity('幽灵船停在港口', { topK: 0 })).toEqual([])
  })

  it('空索引、无法成词的查询和无共同词时返回空数组', () => {
    expect(new Bm25Index().similarity('幽灵船')).toEqual([])
    const index = indexOf(existing, 3)
    expect(index.similarity('')).toEqual([])
    expect(index.similarity('火')).toEqual([])
    expect(index.similarity('zzz qqq')).toEqual([])
  })

  it('删除与覆盖后不再与旧正文比较', () => {
    const index = indexOf(existing, 5)
    index.add({ id: 'base', text: '完全改写后的另一段话' })
    expect(scoreOf(index, existing)).toBe(0)
    expect(scoreOf(index, '完全改写后的另一段话')).toBe(1)
    index.remove('base')
    expect(scoreOf(index, '完全改写后的另一段话')).toBe(0)
  })
})

describe('时间衰减', () => {
  const now = 1_000_000_000

  function makeTimedIndex(): Bm25Index {
    const index = new Bm25Index()
    index.add({ id: 'new', text: '幽灵船的传说', ts: now })
    index.add({ id: 'old', text: '幽灵船的传说', ts: now - 2000 })
    return index
  }

  it('旧文档分数按半衰期降低，固定 now 结果确定', () => {
    const index = makeTimedIndex()
    const base = index.search('幽灵船')
    // 无衰减时两者同分，按 id 字典序 new < old
    expect(base.map(h => h.id)).toEqual(['new', 'old'])

    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed.map(h => h.id)).toEqual(['new', 'old'])
    // old 经过 2 个半衰期 → ×0.25；new 不衰减
    const baseOld = base.find(h => h.id === 'old')!.score
    const decayedOld = decayed.find(h => h.id === 'old')!.score
    const decayedNew = decayed.find(h => h.id === 'new')!.score
    expect(decayedOld).toBeCloseTo(baseOld * 0.25, 10)
    expect(decayedNew).toBeCloseTo(base[0]!.score, 10)
    expect(decayedOld).toBeLessThan(decayedNew)
  })

  it('未来时间戳不放大（衰减因子为 1）', () => {
    const index = new Bm25Index()
    index.add({ id: 'future', text: '幽灵船的传说', ts: now + 60_000 })
    const plain = index.search('幽灵船', { now })
    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed[0]!.score).toBeCloseTo(plain[0]!.score, 10)
  })

  it('文档不带 ts 时不参与衰减', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '幽灵船的传说' })
    const plain = index.search('幽灵船', { now })
    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed[0]!.score).toBeCloseTo(plain[0]!.score, 10)
  })
})

describe('索引维护', () => {
  it('同 id 重复 add = 覆盖', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '魔法塔' })
    index.add({ id: 'a', text: '幽灵船' })
    expect(index.size).toBe(1)
    expect(index.search('魔法')).toEqual([])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['a'])
  })

  it('remove / has / size', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '魔法塔' })
    index.add({ id: 'b', text: '幽灵船' })
    expect(index.size).toBe(2)
    expect(index.has('a')).toBe(true)
    index.remove('a')
    expect(index.has('a')).toBe(false)
    expect(index.size).toBe(1)
    // df 同步撤除：被删文档的专有词不再命中
    expect(index.search('魔法')).toEqual([])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['b'])
    // 删除不存在的 id 不报错
    index.remove('missing')
    expect(index.size).toBe(1)
  })

  it('clear 清空索引', () => {
    const index = makeIndex()
    index.clear()
    expect(index.size).toBe(0)
    expect(index.search('魔法')).toEqual([])
  })

  it('空索引搜索返回空数组', () => {
    expect(new Bm25Index().search('魔法')).toEqual([])
  })
})

describe('确定性', () => {
  it('并列分按 id 字典序升序，且多次搜索一致', () => {
    const index = new Bm25Index()
    index.add({ id: 'c', text: '幽灵船' })
    index.add({ id: 'a', text: '幽灵船' })
    index.add({ id: 'b', text: '幽灵船' })
    const first = index.search('幽灵')
    expect(first.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['a', 'b', 'c'])
  })

  it('topK 截断', () => {
    const index = new Bm25Index()
    index.add({ id: 'c', text: '幽灵船' })
    index.add({ id: 'a', text: '幽灵船' })
    index.add({ id: 'b', text: '幽灵船' })
    expect(index.search('幽灵', { topK: 2 }).map(h => h.id)).toEqual(['a', 'b'])
  })
})
