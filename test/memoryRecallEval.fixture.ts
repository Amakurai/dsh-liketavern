/**
 * 记忆检索评测集（手写工厂数据）：一座虚构港口城的 52 条剧情记忆、可按需生成的无关干扰记忆，
 * 以及「最近几条消息 → 应召回的记忆」场景。不含任何真实剧情，不调用模型。
 * 期望命中由人工指定，只衡量词面检索：没有共同字词的指代不算应召回。
 */

export interface EvalMemory {
  id: string
  body: string
  keys?: string[]
}

export interface EvalMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * single：查询的关键信息是单个汉字（单字名、单字名词）。
 * focus：最新输入问的是前文没有出现的事，前文是一长段别的场景。
 * context：最新输入只是推进剧情的短句，相关记忆来自前文场景。
 * mixed：最新输入既接着场景，又带出一个新线索。
 * none：与任何记忆都无关的短句，理想结果是没有命中。
 */
export interface EvalScenario {
  id: string
  kind: 'single' | 'focus' | 'context' | 'mixed' | 'none'
  messages: EvalMessage[]
  /** 应进入前 5 的记忆，按重要性排列；第一条是最该出现的。none 场景为空。 */
  expected: string[]
  /** 前 5 条必须非空且每条正文都含这个字：用于「问到某个单字名」而不指定具体哪一条的场景。 */
  mention?: string
}

// ---------------------------------------------------------------------------
// 剧情记忆
// ---------------------------------------------------------------------------

export const EVAL_MEMORIES: EvalMemory[] = [
  { id: 'm01', body: '艾琳是雾港巡夜队的新人，左手惯用，随身带一把短弩。', keys: ['艾琳', '小狐狸'] },
  { id: 'm02', body: '罗兰是巡夜队队长，三年前在北门失去了右眼。', keys: ['罗兰', '队长'] },
  { id: 'm03', body: '凛是独来独往的佣兵，外号红隼，只接护送的活。', keys: ['凛', '红隼'] },
  { id: 'm04', body: '凛的妹妹叫樱，在旧图书馆做抄写员，身体不好。', keys: ['樱'] },
  { id: 'm05', body: '樱每个月初七要去教堂后院取药，药钱一直是凛在付。' },
  { id: 'm06', body: '艾琳捡到的白猫取名叫雪，现在养在巡夜队的值班室。', keys: ['雪'] },
  { id: 'm07', body: '线人墨只在黑礁酒馆的后门见人，暗号是敲三下再敲一下。', keys: ['墨', '线人'] },
  { id: 'm08', body: '翡翠钥匙藏在钟楼顶层第三块松动的砖后面，只有艾琳和罗兰知道。', keys: ['翡翠钥匙'] },
  { id: 'm09', body: '翡翠钥匙能打开伯爵府地窖的铁门，这是塞巴斯酒后说漏嘴的。' },
  { id: 'm10', body: '艾琳把父亲留下的银怀表押给了黑礁酒馆的老乔，换了二十枚银币。', keys: ['银怀表'] },
  { id: 'm11', body: '老乔答应替艾琳保管银怀表到冬至，过期就卖掉。' },
  { id: 'm12', body: '断剑霜牙是凛的佩剑，剑尖断在三年前的北门之战。', keys: ['霜牙'] },
  { id: 'm13', body: '诺瓦说重铸霜牙需要星陨铁，整个雾港只有维多利亚的收藏里有一块。' },
  { id: 'm14', body: '维多利亚女伯爵表面资助巡夜队，暗中在码头仓库囤积火药。', keys: ['维多利亚', '女伯爵'] },
  { id: 'm15', body: '艾琳在码头仓库的三号库看见了印着伯爵纹章的火药桶，还没有告诉任何人。' },
  { id: 'm16', body: '塞巴斯是伯爵府的老管家，欠了老乔一大笔赌债。' },
  { id: 'm17', body: '罗兰怀疑巡夜队里有内鬼，让艾琳暗中留意副队长格雷。' },
  { id: 'm18', body: '格雷每逢雨夜都会独自去灯塔，回来时靴子上沾着红泥。' },
  { id: 'm19', body: '灯塔看守人是个哑巴老人，他给过艾琳一张画着暗礁位置的航海图。', keys: ['航海图'] },
  { id: 'm20', body: '航海图背面有一行小字：潮退之时，礁门自开。' },
  { id: 'm21', body: '地下水道的入口在集市鱼摊后面，凛带艾琳走过一次。' },
  { id: 'm22', body: '艾琳怕水，小时候在雾港的运河里差点淹死。' },
  { id: 'm23', body: '艾琳答应过凛，无论发生什么都不把樱牵扯进来。' },
  { id: 'm24', body: '北门每晚亥时落锁，只有持队长令牌的人能出入。' },
  { id: 'm25', body: '罗兰把备用的队长令牌交给了艾琳，嘱咐她只在紧急时使用。', keys: ['令牌'] },
  { id: 'm26', body: '蓝宝石胸针是维多利亚亡夫的遗物，她从不离身。', keys: ['胸针'] },
  { id: 'm27', body: '艾琳在伯爵府的舞会上假扮侍女，被塞巴斯认了出来，但他没有声张。' },
  { id: 'm28', body: '凛讨厌甜食，却总在口袋里放一包给樱带的糖渍梅子。' },
  { id: 'm29', body: '艾琳和凛第一次见面是在集市，凛替她挡下了一个扒手的刀。' },
  { id: 'm30', body: '旧图书馆的禁书区在地下二层，钥匙由馆长亲自保管。' },
  { id: 'm31', body: '樱在抄写一本关于潮汐与暗礁的旧书时，发现里面夹着一封没有署名的密信。', keys: ['密信'] },
  { id: 'm32', body: '密信里提到“冬至之夜，礁门之后”，字迹和格雷的巡逻记录很像。' },
  { id: 'm33', body: '艾琳的短弩是诺瓦改装过的，可以连发两箭，但第二箭准头差。' },
  { id: 'm34', body: '诺瓦是铁匠铺的学徒，暗恋樱，常借口送书签去旧图书馆。' },
  { id: 'm35', body: '老乔年轻时当过走私船的水手，认得雾港所有的暗礁。' },
  { id: 'm36', body: '黑礁酒馆每逢十五有地下赌局，塞巴斯是常客。' },
  { id: 'm37', body: '艾琳上次发烧时，凛守了她一整夜，这件事两个人都没再提。' },
  { id: 'm38', body: '巡夜队的值班室在钟楼一层，夜里只留一盏灯。' },
  { id: 'm39', body: '罗兰的右眼是被一个戴蓝宝石戒指的人刺伤的，他一直在找这个人。' },
  { id: 'm40', body: '雪很怕生，只肯让艾琳和樱抱。' },
  { id: 'm41', body: '艾琳欠诺瓦三枚银币的改装费，说好月底还。' },
  { id: 'm42', body: '维多利亚邀请艾琳冬至那天去伯爵府赴宴，请柬放在值班室的抽屉里。' },
  { id: 'm43', body: '墨告诉艾琳，最近有一艘没有旗号的船在暗礁外停了三个晚上。' },
  { id: 'm44', body: '格雷的妹妹在伯爵府做侍女，这是他把柄所在。' },
  { id: 'm45', body: '凛左肩有一道旧伤，阴雨天会疼，她不让别人知道。' },
  { id: 'm46', body: '艾琳习惯在紧张时摸左耳的耳钉，那是母亲留给她的。' },
  { id: 'm47', body: '集市的鱼摊老板娘知道地下水道的近路，但要价很高。' },
  { id: 'm48', body: '钟楼的大钟三年前就停了，指针一直停在亥时。' },
  // 名字本身是数词：只有靠单字 key 声明才检索得到
  { id: 'm49', body: '七是凛早年的搭档，三年前在南方失踪，凛一直在打听他的下落。', keys: ['七'] },
  // 只在这一条里出现过一次、也没有写进 keys 的单字名
  { id: 'm50', body: '铁匠铺的老板叫岩，脾气很坏，只肯把手艺教给诺瓦。' },
  { id: 'm51', body: '艾琳把那封没有署名的信交给了茉，托她转给馆长。' },
  { id: 'm52', body: '码头的搬运工头领绰号鲸，只听维多利亚的吩咐。' },
]

/**
 * 让「凛」变成常见单字名的补充记忆：加上之后她出现在 25 条里，约占四成。
 * 用来衡量主角级的单字名还能不能被检索到。
 */
export const EVAL_COMMON_NAME_MEMORIES: EvalMemory[] = [
  { id: 'r01', body: '凛每次接活之前都要先收一半定金。' },
  { id: 'r02', body: '凛不喝酒，在黑礁酒馆只点一杯热姜茶。' },
  { id: 'r03', body: '凛的斗篷内衬缝着三把飞刀。' },
  { id: 'r04', body: '凛欠灯塔看守人一个人情，具体缘由不肯说。' },
  { id: 'r05', body: '凛和罗兰是旧识，两人曾在北门并肩作战。' },
  { id: 'r06', body: '凛认得维多利亚府上的暗纹，说那是南方商会的标记。' },
  { id: 'r07', body: '凛答应护送艾琳去一趟地下水道，报酬是一顿饭。' },
  { id: 'r08', body: '凛睡觉时也握着剑柄，这是当佣兵多年的习惯。' },
  { id: 'r09', body: '凛教过艾琳怎样在雾里辨认方向。' },
  { id: 'r10', body: '凛对格雷没有好感，说他的眼神像在算账。' },
  { id: 'r11', body: '凛的左手小指缺了一截，是早年被捕兽夹夹断的。' },
  { id: 'r12', body: '凛在集市有个固定的线人，卖旧货的瘸腿老头。' },
  { id: 'r13', body: '凛从不谈起自己的故乡，只说那里常年下雪。' },
  { id: 'r14', body: '凛把赚来的钱分成三份，一份寄给樱，一份存进钱庄。' },
]

/**
 * 小库：只含前文场景的期望记忆，以及正文里带「没有 / 知道 / 现在 / 什么」这类功能词的几条。
 * 库越小，一个偶然撞上的功能词越显得稀有，用来衡量闲聊输入加权后会不会挤掉场景记忆。
 */
export const EVAL_SMALL_IDS = ['m06', 'm08', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19', 'm21', 'm23', 'm26', 'm27',
  'm31', 'm36', 'm38', 'm43', 'm45', 'm47']

// ---------------------------------------------------------------------------
// 干扰记忆：同一座城里与评测场景无关的琐事，用来把库撑到接近容量上限
// ---------------------------------------------------------------------------

const DISTRACTOR_PEOPLE = ['裁缝阿芙', '面包师老潘', '药剂师柯林', '邮差小满', '渡船夫阿七', '书记官贺文', '花匠苏伯',
  '货郎石头', '歌女莉塔', '税吏巴顿', '木匠老梁', '修女安娜', '车夫大刘', '学徒小五', '更夫老周', '染坊娘子']
const DISTRACTOR_PLACES = ['东街', '染坊', '面包房', '河对岸的磨坊', '税务所', '修道院', '南城墙', '驿站', '布行', '渡口',
  '学堂', '菜园', '石桥', '马厩', '公共浴场']
const DISTRACTOR_EVENTS = ['订了一批过冬的木柴', '和邻居为了院墙吵了一架', '捡到一只走失的山羊', '把招牌重新漆成了绿色',
  '收到一封从外省寄来的家书', '摔坏了祖传的陶罐', '答应教孩子们认字', '多收了三个铜板又退了回去', '在屋顶上发现了燕子窝',
  '因为下雨推迟了开张', '给巷口的乞丐送了一碗热汤', '把旧马车卖给了外乡人', '养的鸽子飞走了两只', '跟人打赌输了一顿酒',
  '修好了漏雨的窗框', '半夜听见井里有回声', '新雇了一个不爱说话的帮工', '把账本弄丢了又在柜底找到', '学会了腌一种酸菜',
  '送走了要去外省读书的侄子']
const DISTRACTOR_NOTES = ['这件事街坊都知道', '此后再没有人提起', '当时并没有旁人在场', '据说下个月还会再来一次', '看起来心情不错',
  '为此闷闷不乐了好几天', '只是随口说说而已', '后来证明是一场误会', '大家都觉得理所当然', '到现在也没个结果']

/** 确定性地组合出 count 条互不相同的干扰记忆（最多 16 × 15 = 240 条）。 */
export function evalDistractors(count: number): EvalMemory[] {
  const out: EvalMemory[] = []
  for (let i = 0; i < count; i++) {
    const person = DISTRACTOR_PEOPLE[i % DISTRACTOR_PEOPLE.length]!
    const place = DISTRACTOR_PLACES[Math.floor(i / DISTRACTOR_PEOPLE.length) % DISTRACTOR_PLACES.length]!
    const event = DISTRACTOR_EVENTS[(i * 7 + 3) % DISTRACTOR_EVENTS.length]!
    const note = DISTRACTOR_NOTES[(i * 3 + 1) % DISTRACTOR_NOTES.length]!
    out.push({ id: `d${String(i).padStart(3, '0')}`, body: `${person}在${place}${event}，${note}。` })
  }
  return out
}

// ---------------------------------------------------------------------------
// 场景前文：每段是「助手长叙述 → 用户短句 → 助手长叙述」，最后再接各场景自己的最新输入
// ---------------------------------------------------------------------------

const TAVERN: EvalMessage[] = [
  { role: 'assistant', content: '黑礁酒馆里烟气缭绕，角落的长桌上骰子滚个不停。老乔一边擦着杯子，一边朝艾琳抬了抬下巴：“小狐狸，今晚巡夜队不用点卯？”他的声音压得很低，目光却越过她的肩膀，落在赌桌那头的塞巴斯身上。老管家已经输红了眼，袖口的纹章扣子都押了上去。艾琳顺着他的视线看了一眼，手指在吧台上轻轻敲了两下。“我只是来喝一杯的。”她说。老乔哼了一声，把一杯兑了水的麦酒推到她面前，没有收钱。' },
  { role: 'user', content: '他今晚输了多少？' },
  { role: 'assistant', content: '“比上个月加起来还多。”老乔把抹布甩到肩上，凑近了些，“十五的赌局他从不缺席，可今晚不一样，他押的不是钱。”赌桌那边爆发出一阵哄笑，塞巴斯猛地站起身，椅子在地板上刮出刺耳的声音。他踉跄着朝后门走去，经过吧台时脚步顿了一下，像是认出了艾琳，又像只是喝多了。老乔的手在吧台下面按住了什么，直到那扇门重新关上，才慢慢松开。“你要是想问他话，”他说，“最好趁他还欠着我的时候。”' },
]

const WAREHOUSE: EvalMessage[] = [
  { role: 'assistant', content: '夜雾从海面漫上来，把码头的灯火泡成一团团昏黄。艾琳贴着三号库的外墙蹲下，短弩横在膝上，耳边只有缆绳磨着木桩的吱呀声。仓库的侧门虚掩着，门缝里漏出一线灯光，还有人压着嗓子说话。她屏住呼吸，从门缝往里看：十几只木桶码得整整齐齐，桶身上烙着她再熟悉不过的纹章。两个搬运工正把最后一只桶滚上板车，其中一个抱怨道：“冬至之前要全部运走，夫人催得紧。”' },
  { role: 'user', content: '我再靠近一点，看清楚桶上写了什么。' },
  { role: 'assistant', content: '艾琳沿着墙根挪了两步，木板在脚下发出一声轻响。搬运工的谈话戛然而止。她立刻伏低身子，心跳得像擂鼓。过了好一会儿，里面才重新响起板车的轱辘声。借着晃动的灯光，她看清了桶盖上用红漆刷的字：小心火烛。旁边还有一行更小的编号，和上个月巡夜队查获的那批走私货一模一样。海风忽然转了向，带来一股刺鼻的硫磺味。远处的钟楼沉默着，雾港的夜还很长。' },
]

const DUTY_ROOM: EvalMessage[] = [
  { role: 'assistant', content: '值班室里只点着一盏灯，罗兰背对着门，正往墙上的巡逻表里添名字。听见脚步声，他没有回头。“把门带上。”等门闩落下，他才转过身，那只独眼在灯下显得格外疲惫。“昨晚北门的岗哨少记了一个人出城，”他把一张皱巴巴的记录纸推到桌上，“笔迹是格雷的。我不想冤枉自己人，可这已经是这个月第三次了。”白猫从柜子顶上跳下来，蹭了蹭艾琳的靴子，又钻回了桌底。' },
  { role: 'user', content: '队长，你想让我怎么做？' },
  { role: 'assistant', content: '罗兰沉默了一会儿，用指节敲了敲桌面。“像平常一样巡你的夜。别跟着他，也别问他，只要记下他每次离队的时辰。”他从抽屉里取出一本薄薄的册子递过来，封皮上什么也没写。“记在这里面，不要让第三个人看见。”窗外传来换岗的口令声，远远的，像隔着一层水。罗兰重新转向那张巡逻表，声音低了下去：“艾琳，我宁愿是我多心。”' },
]

const MARKET: EvalMessage[] = [
  { role: 'assistant', content: '集市收摊的时辰，鱼摊前的石板还淌着水。凛靠在一根木柱上，斗篷的兜帽压得很低，只露出半截下巴。“你迟了。”她说，却没有责怪的意思。她朝摊子后面那道不起眼的铁栅栏偏了偏头，“下面的路我只走过两回，潮气重，火把撑不了多久。你要是现在后悔，还来得及。”老板娘在一旁收拾木盆，假装什么也没听见，手却朝她们摊开，掌心朝上。' },
  { role: 'user', content: '我把钱袋递给老板娘，然后看向凛。' },
  { role: 'assistant', content: '老板娘掂了掂钱袋，嘴角一撇，还是侧身让开了路。铁栅栏后面是一段向下的石阶，黑得看不见底，水声从深处一阵阵涌上来。凛已经点着了火把，火光照亮了她左肩上那道被斗篷遮住一半的旧疤。“跟紧我，”她说，“别碰墙上的苔，滑。”她走下两级台阶，又停住，回头看了艾琳一眼，那目光里有一点不易察觉的犹豫。“还有，下面有一段要蹚水。你行吗？”' },
]

const BALLROOM: EvalMessage[] = [
  { role: 'assistant', content: '伯爵府的大厅灯火通明，水晶吊灯把每一张脸都照得发亮。艾琳端着托盘穿过人群，侍女的裙子比她想象的更难走路。维多利亚站在楼梯的转角处，一身墨绿的长裙，胸前那枚胸针在灯下泛着冷光。她正和一位船主模样的客人低声交谈，偶尔抬眼扫过大厅，像在清点自己的东西。乐队换了一支更慢的曲子，宾客们纷纷放下酒杯，朝舞池走去。' },
  { role: 'user', content: '我低着头，从她身边走过去。' },
  { role: 'assistant', content: '擦肩而过的一瞬间，维多利亚的话音停了半拍。艾琳没有抬头，只看见那双缎面鞋的鞋尖朝她转了一点点，又转了回去。“……所以冬至那天，潮水会退得比往年都低。”船主压低声音接着说。艾琳的手一抖，托盘上的酒杯轻轻碰了一下。走廊尽头，塞巴斯正在核对宾客的名册，他抬起头，目光在她脸上停了很久，然后若无其事地低下头，在名册上划了一道。' },
]

const LIGHTHOUSE: EvalMessage[] = [
  { role: 'assistant', content: '雨是后半夜下起来的。艾琳披着油布斗篷，远远缀在那个身影后面，看着他穿过空无一人的鱼市，沿着防波堤一直走向灯塔。灯塔的光柱每转一圈，就把他的影子在湿漉漉的石头上拉长一次。到了塔下，他没有敲门，而是绕到背海的一侧，蹲下去摆弄着什么。艾琳伏在一堆渔网后面，雨水顺着兜帽的边沿往下淌，冷得她直打颤。' },
  { role: 'user', content: '我等他离开以后再过去看。' },
  { role: 'assistant', content: '他在那里待了大约一刻钟才起身，往来路走去，靴子踩在泥里的声音渐渐被雨声盖住。艾琳又等了一会儿，才摸到塔基背海的那一侧。石缝里塞着一只油纸包，包得很仔细，上面压着一块沾满红泥的石头。她刚伸出手，头顶忽然传来木窗推开的吱呀声。看守的老人探出半个身子，冲她用力摆了摆手，又指了指海面。雾里隐约有一点灯火，正贴着暗礁的方向缓缓移动。' },
]

const after = (scene: EvalMessage[], input: string): EvalMessage[] => [...scene, { role: 'user', content: input }]
const alone = (input: string): EvalMessage[] => [{ role: 'user', content: input }]

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

export const EVAL_SCENARIOS: EvalScenario[] = [
  // 单字：没有前文，关键信息只有一个字
  { id: 'single-name-query', kind: 'single', messages: alone('樱'), expected: ['m04', 'm05'] },
  { id: 'single-pet-query', kind: 'single', messages: alone('雪'), expected: ['m06', 'm40'] },
  { id: 'single-informant-query', kind: 'single', messages: alone('墨'), expected: ['m07', 'm43'] },
  { id: 'single-mention-query', kind: 'single', messages: alone('凛'), expected: [], mention: '凛' },
  { id: 'single-name-question', kind: 'single', messages: alone('凛去哪了？'), expected: [], mention: '凛' },
  { id: 'single-noun-question', kind: 'single', messages: alone('樱的药还够吗'), expected: ['m05', 'm04'] },
  { id: 'single-pet-question', kind: 'single', messages: alone('雪今天吃东西了吗？'), expected: ['m06', 'm40'] },
  { id: 'single-name-after-scene', kind: 'single', messages: after(MARKET, '下去之前我想先问一句，樱的药还够吗？'), expected: ['m05', 'm04'] },
  { id: 'single-informant-after-scene', kind: 'single', messages: after(TAVERN, '墨上次说的那艘船怎么样了？'), expected: ['m43', 'm07'] },
  // 名字是功能字，但被单字 key 声明过
  { id: 'single-declared-key', kind: 'single', messages: alone('七后来怎么样了？'), expected: ['m49'] },
  // 只出现过一次的单字名，放在句子里问
  { id: 'single-once-named', kind: 'single', messages: alone('岩最近还收徒弟吗'), expected: ['m50'] },
  { id: 'single-once-object', kind: 'single', messages: after(BALLROOM, '那封信后来茉转交了吗？'), expected: ['m51'] },
  { id: 'single-once-nickname', kind: 'single', messages: alone('鲸听谁的'), expected: ['m52'] },
  // 「弩」只出现在「短弩」里，不算独立成词；直接搜这个字时仍应找到
  { id: 'single-bound-char-query', kind: 'single', messages: alone('弩'), expected: [], mention: '弩' },

  // 焦点：最新输入问的是前文没有的事
  { id: 'focus-key', kind: 'focus', messages: after(TAVERN, '对了，翡翠钥匙你放在哪儿了？'), expected: ['m08', 'm09'] },
  { id: 'focus-sister', kind: 'focus', messages: after(WAREHOUSE, '先不说这个。凛的妹妹最近身体怎么样？'), expected: ['m04'] },
  { id: 'focus-watch', kind: 'focus', messages: after(DUTY_ROOM, '我那块银怀表还赎得回来吗？'), expected: ['m10', 'm11'] },
  { id: 'focus-chart', kind: 'focus', messages: after(MARKET, '等等，航海图背面写了什么来着？'), expected: ['m20', 'm19'] },
  { id: 'focus-debt', kind: 'focus', messages: after(BALLROOM, '诺瓦那边的改装费我还欠多少？'), expected: ['m41', 'm33'] },
  { id: 'focus-token', kind: 'focus', messages: after(LIGHTHOUSE, '罗兰给我的令牌带在身上吗？'), expected: ['m25', 'm24'] },
  { id: 'focus-sword', kind: 'focus', messages: after(BALLROOM, '霜牙要重铸的话还缺什么？'), expected: ['m13', 'm12'] },

  // 前文：最新输入只是推进剧情，相关记忆来自场景
  { id: 'context-sewer', kind: 'context', messages: after(MARKET, '好，那我们走吧。'), expected: ['m21', 'm47'] },
  { id: 'context-tavern', kind: 'context', messages: after(TAVERN, '嗯，再来一杯。'), expected: ['m16', 'm36'] },
  { id: 'context-tavern-negation', kind: 'context', messages: after(TAVERN, '没有，你继续说。'), expected: ['m16', 'm36'] },
  { id: 'context-lighthouse', kind: 'context', messages: after(LIGHTHOUSE, '我先不动那个纸包。'), expected: ['m18', 'm19'] },
  { id: 'context-duty-room', kind: 'context', messages: after(DUTY_ROOM, '我明白了。'), expected: ['m17', 'm38'] },
  { id: 'context-ballroom', kind: 'context', messages: after(BALLROOM, '……我继续往前走。'), expected: ['m27', 'm26'] },
  { id: 'context-warehouse', kind: 'context', messages: after(WAREHOUSE, '继续盯着，先别出声。'), expected: ['m15', 'm14'] },
  // 以下几句闲聊带着记忆正文里也有的功能词（知道、现在、没有、什么）
  { id: 'context-tavern-know', kind: 'context', messages: after(TAVERN, '我知道了，你接着说。'), expected: ['m16', 'm36'] },
  { id: 'context-lighthouse-now', kind: 'context', messages: after(LIGHTHOUSE, '现在怎么办？'), expected: ['m18', 'm19'] },
  { id: 'context-ballroom-nobody', kind: 'context', messages: after(BALLROOM, '没有人注意到我吧？'), expected: ['m27', 'm26'] },
  { id: 'context-warehouse-what', kind: 'context', messages: after(WAREHOUSE, '什么？他们是谁的人？'), expected: ['m15', 'm14'] },

  // 混合：接着场景，同时带出新线索
  { id: 'mixed-reef-gate', kind: 'mixed', messages: after(TAVERN, '老乔，你当年跑船的时候见过礁门吗？'), expected: ['m35', 'm20'] },
  { id: 'mixed-north-gate', kind: 'mixed', messages: after(DUTY_ROOM, '队长，北门落锁以后我还能出去吗？'), expected: ['m24', 'm25'] },
  { id: 'mixed-invitation', kind: 'mixed', messages: after(BALLROOM, '冬至的请柬我放在哪儿了？'), expected: ['m42'] },
  { id: 'mixed-warehouse-countess', kind: 'mixed', messages: after(WAREHOUSE, '这些火药和维多利亚有关系吗？'), expected: ['m14', 'm15'] },

  // 无关：与任何记忆都没有关系的短句
  { id: 'none-unrelated', kind: 'none', messages: alone('完全无关的一句话'), expected: [] },
  { id: 'none-weather', kind: 'none', messages: alone('今天天气真不错'), expected: [] },
  { id: 'none-tomorrow', kind: 'none', messages: alone('明天再说吧'), expected: [] },
  { id: 'none-dragon', kind: 'none', messages: alone('龙的弱点是什么'), expected: [] },
  { id: 'none-hungry', kind: 'none', messages: alone('我想吃点东西'), expected: [] },
  { id: 'none-story', kind: 'none', messages: alone('这个故事讲得怎么样'), expected: [] },
  { id: 'none-name', kind: 'none', messages: alone('你叫什么名字'), expected: [] },
  { id: 'none-joke', kind: 'none', messages: alone('给我讲个笑话'), expected: [] },
  { id: 'none-hiking', kind: 'none', messages: alone('周末打算去爬山'), expected: [] },
  { id: 'none-song', kind: 'none', messages: alone('这首歌真好听'), expected: [] },
  { id: 'none-ticket', kind: 'none', messages: alone('帮我订一张机票'), expected: [] },
  { id: 'none-dinner', kind: 'none', messages: alone('晚饭吃面条还是米饭'), expected: [] },
  { id: 'none-battery', kind: 'none', messages: alone('手机快没电了'), expected: [] },
  { id: 'none-umbrella', kind: 'none', messages: alone('下雨记得带伞'), expected: [] },
  { id: 'none-movie', kind: 'none', messages: alone('电影几点开始'), expected: [] },
  { id: 'none-coffee', kind: 'none', messages: alone('咖啡不加糖谢谢'), expected: [] },
  { id: 'none-homework', kind: 'none', messages: alone('作业还没写完'), expected: [] },
  { id: 'none-subway', kind: 'none', messages: alone('地铁站怎么走'), expected: [] },
  { id: 'none-birthday', kind: 'none', messages: alone('生日快乐'), expected: [] },
  { id: 'none-alarm', kind: 'none', messages: alone('明早七点叫我起床'), expected: [] },
]

// ---------------------------------------------------------------------------
// 英文记忆与场景：功能词表只覆盖中文，用来确认整词文字的检索与最新输入加权不依赖它
// ---------------------------------------------------------------------------

export const EVAL_EN_MEMORIES: EvalMemory[] = [
  { id: 'e01', body: 'Mara keeps the brass key in a hollow book on the third shelf.' },
  { id: 'e02', body: 'Tobias lost his left hand in the mill fire and blames the mayor.' },
  { id: 'e03', body: 'The ferry to Greywater only runs at dawn and at dusk.' },
  { id: 'e04', body: 'Mara promised Tobias she would never go back to the lighthouse.' },
  { id: 'e05', body: 'Old Finn sells smuggled tea from the back room of the Anchor Inn.' },
  { id: 'e06', body: 'The mayor owes Old Finn forty silver and has not paid.' },
  { id: 'e07', body: 'Ines is afraid of dogs after the hunt in the northern woods.' },
  { id: 'e08', body: 'The lighthouse lamp has been dark since the storm three winters ago.' },
  { id: 'e09', body: 'Tobias hides a map of the tunnels inside his wooden hand.' },
  { id: 'e10', body: 'Ines and Mara are sisters but have not spoken in a year.' },
  { id: 'e11', body: 'The Anchor Inn has no rooms on the night of the harvest fair.' },
  { id: 'e12', body: 'A stranger in a red coat has been asking about the brass key.' },
  { id: 'e13', body: 'The mill has stood empty since the fire and no one will go near it.' },
  { id: 'e14', body: 'Ines owes the ferryman a favor she does not want to repay.' },
]

const INN: EvalMessage[] = [
  { role: 'assistant', content: 'The Anchor Inn was loud that night. Old Finn stood behind the bar, wiping the same mug he had been wiping for an hour, and he did not look up when the door opened. A fiddler in the corner played a tune that no one was listening to. The mayor sat alone by the fire with his back to the room, and he had not touched his drink. Finn slid a cup of tea across the bar without being asked. "It is on the house," he said, "but do not tell the others."' },
  { role: 'user', content: 'I take the cup and nod toward the mayor.' },
  { role: 'assistant', content: 'Finn followed the nod and his face went still. "He has been here since noon," he said quietly. "He owes half the town and he knows that I know it. There is no reason for a man like that to sit in my inn unless he wants something." He set the mug down at last. Outside, the wind had turned, and the shutters knocked against the wall. "If you have questions for him, ask them soon. He will not stay once the fair crowd comes in."' },
]

export const EVAL_EN_SCENARIOS: EvalScenario[] = [
  { id: 'en-focus-key', kind: 'focus', messages: after(INN, 'By the way, where did you put the brass key?'), expected: ['e01', 'e12'] },
  { id: 'en-focus-sisters', kind: 'focus', messages: after(INN, 'Do Ines and Mara still not talk to each other?'), expected: ['e10'] },
  { id: 'en-context-go-on', kind: 'context', messages: after(INN, 'No, go on.'), expected: ['e06', 'e05'] },
  { id: 'en-context-not-yet', kind: 'context', messages: after(INN, 'I have not asked him yet, and I do not want to.'), expected: ['e06', 'e05'] },
  { id: 'en-context-continue', kind: 'context', messages: [...INN], expected: ['e06', 'e05'] },
  { id: 'en-mixed-tobias', kind: 'mixed', messages: after(INN, 'Finn, has Tobias been in tonight?'), expected: ['e02'] },
  { id: 'en-none-morning', kind: 'none', messages: alone('What a lovely morning it is.'), expected: [] },
  { id: 'en-none-weekend', kind: 'none', messages: alone('Do you have any plans for the weekend?'), expected: [] },
]
