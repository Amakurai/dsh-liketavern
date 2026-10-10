/**
 * 记忆检索留出集（手写工厂数据）：一座虚构空间站的 32 条剧情记忆与场景。
 *
 * 用途是检查检索规则有没有只对开发评测集（memoryRecallEval.fixture.ts）调得好看：
 * 这一份在规则定稿之后才写，按平常记事实的写法写，写的时候不对照规则，写完也不为了通过而改动正文或查询。
 * 结果如实记录在 memoryRecallHoldout.test.ts 里，包括没通过的场景。不含任何真实剧情，不调用模型。
 * paraphrase 一类是换了说法、与记忆几乎没有共同字词的问法，用来标出词面检索做不到的部分。
 */
import type { EvalMemory, EvalMessage } from './memoryRecallEval.fixture.js'

export interface HoldoutScenario {
  id: string
  kind: 'single' | 'focus' | 'context' | 'mixed' | 'none' | 'paraphrase'
  messages: EvalMessage[]
  /** 应进入前 5 的记忆；第一条是最该出现的。none 场景为空。 */
  expected: string[]
  /** 前 5 条必须非空且每条正文都含这个字。 */
  mention?: string
}

export const HOLDOUT_MEMORIES: EvalMemory[] = [
  { id: 'h01', body: '岚是灰烬站的轮机长，右腿是义肢。' },
  { id: 'h02', body: '岚和砚曾在同一艘货船上服役，后来因为一次事故闹翻。' },
  { id: 'h03', body: '砚负责站里的水循环系统，每天凌晨四点巡检。' },
  { id: 'h04', body: '砚的女儿叫禾，寄养在三号环区的姑妈家。' },
  { id: 'h05', body: '禾对合成蛋白过敏，只能吃温室种的豆子。' },
  { id: 'h06', body: '站长莫里森三年前就该退休，却一直没有人来接任。' },
  { id: 'h07', body: '莫里森的保险柜密码是他妻子的生日，岚偷看过一次。' },
  { id: 'h08', body: '七号气闸的外门密封圈老化，开启时必须先手动泄压。' },
  { id: 'h09', body: '走私贩子老K每个月随补给船来一次，只收实物不收信用点。' },
  { id: 'h10', body: '老K欠岚一台二手的离子焊机，说好下次补给带来。' },
  { id: 'h11', body: '温室的主管叫苏禾，她培育的蓝番茄能卖出十倍价钱。' },
  { id: 'h12', body: '补给船“白鹭号”每四十天停靠一次，停靠窗口只有六小时。' },
  { id: 'h13', body: '医务室的止痛剂上个月少了两箱，值班记录被人改过。' },
  { id: 'h14', body: '值班医生柯文有赌瘾，欠了老K一大笔钱。' },
  { id: 'h15', body: '岚在轮机舱的工具柜夹层里藏了一把老式手枪。' },
  { id: 'h16', body: '站里的备用电源只能撑七十二小时，这件事只有岚和莫里森知道。' },
  { id: 'h17', body: '砚发现水循环的过滤芯被人换成了次品，怀疑和柯文有关。' },
  { id: 'h18', body: '通讯塔每逢恒星风暴就会中断，最长一次断了九天。' },
  { id: 'h19', body: '机修学徒小满总是偷偷给禾带温室的草莓。' },
  { id: 'h20', body: '小满是孤儿，把岚当成父亲一样看待。' },
  { id: 'h21', body: '莫里森的副手艾达一直在向总部写匿名报告。' },
  { id: 'h22', body: '艾达和柯文是表兄妹，这层关系站里没人知道。' },
  { id: 'h23', body: '三号环区的重力发生器经常故障，住户都习惯把东西绑在墙上。' },
  { id: 'h24', body: '岚的义肢需要每半年校准一次，上次校准已经拖了两个月。' },
  { id: 'h25', body: '流浪猫豆是随白鹭号偷渡上站的，现在住在温室。' },
  { id: 'h26', body: '豆抓伤过柯文，从那以后柯文不敢进温室。' },
  { id: 'h27', body: '总部计划明年关闭灰烬站，消息还没有公开。' },
  { id: 'h28', body: '砚答应过禾，等水循环修好就带她去看一次日出舱。' },
  { id: 'h29', body: '日出舱的观景窗有一道裂纹，被莫里森下令封锁。' },
  { id: 'h30', body: '老K手里有一份灰烬站的原始结构图，开价五百信用点。' },
  { id: 'h31', body: '岚的旧船友里有个绰号叫鸦的领航员，据说还活着。' },
  { id: 'h32', body: '艾达的终端里存着一份名单，上面有老K的真名。' },
]

const ENGINE: EvalMessage[] = [
  { role: 'assistant', content: '轮机舱里热得像蒸笼，主轴的嗡鸣隔着护板都能震到牙根。岚蹲在三号泵旁边，义肢的膝关节发出一声不太对劲的咔哒。他没理会，把扳手递给身后的小满：“再紧半圈，别用蛮力。”少年咬着牙拧完，抹了一把额头上的汗，眼睛却往舱门那边瞟。岚头也没回：“想去温室就直说，干完这台泵再走。”' },
  { role: 'user', content: '我靠在门边，问他这台泵还能撑多久。' },
  { role: 'assistant', content: '“撑到下一班补给没问题，再往后我不敢说。”岚站起身，用抹布擦了擦手，目光扫过墙上那排跳动的读数，“过滤那边要是再出岔子，整条回路的压力都得我这儿扛。”他顿了顿，像是想起了什么不愿意提的事，声音低了些：“这些话你别往上面传。上面的人只看报表，报表上一切正常。”小满在一旁假装整理工具，耳朵却竖得老高。' },
]

const GREENHOUSE: EvalMessage[] = [
  { role: 'assistant', content: '温室的灯是全站唯一像阳光的东西。苏禾戴着手套，正把一株蓝番茄的侧枝一根根掐掉，动作又快又准。架子底下，一只橘色的猫蜷在保温垫上，尾巴尖一下一下地拍着地面。“别碰那一排，”她头也不抬地说，“那是留种的，碰坏一颗我跟你没完。”空气里有湿土和番茄叶的味道，循环风扇慢悠悠地转着。' },
  { role: 'user', content: '我蹲下来，伸手想摸摸那只猫。' },
  { role: 'assistant', content: '猫睁开一只眼，打量了一下伸过来的手，居然没有躲，只是把下巴搁回爪子上。苏禾这才抬头看了一眼，有点意外：“它平时可没这么好说话。上回有人想抱它，胳膊上留了三道口子，到现在都绕着这儿走。”她摘下手套，从兜里摸出半块压缩饼干掰碎了放在垫子边上，“你要是真闲着，帮我把那边的营养液兑了。配比写在桶上，别自作主张。”' },
]

const INFIRMARY: EvalMessage[] = [
  { role: 'assistant', content: '医务室的灯管有一根在闪。柯文坐在诊疗台后面，面前摊着一本纸质的值班记录，手里的笔转了一圈又一圈，就是没落下去。看见有人进来，他啪地合上本子，脸上堆出一个过分热情的笑：“哪儿不舒服？头疼还是失眠？这个月失眠的人特别多。”药柜的玻璃门上贴着封条，其中一张的边角翘了起来，像是被人揭开过又按回去的。' },
  { role: 'user', content: '我说只是来拿点感冒药。' },
  { role: 'assistant', content: '“感冒药，行，感冒药有的是。”柯文拉开抽屉翻了翻，递过来一板药片，手指却在微微发抖。他顺着访客的视线看到了那张翘边的封条，喉结动了一下，“那个啊，上周盘库的时候不小心蹭到的，别在意。”走廊里传来脚步声，他猛地扭头去看，直到脚步声走远才松了口气，又把那本值班记录往抽屉深处推了推。' },
]

const after = (scene: EvalMessage[], input: string): EvalMessage[] => [...scene, { role: 'user', content: input }]
const alone = (input: string): EvalMessage[] => [{ role: 'user', content: input }]

export const HOLDOUT_SCENARIOS: HoldoutScenario[] = [
  // 单字名与单字名词
  { id: 'single-engineer', kind: 'single', messages: alone('岚'), expected: [], mention: '岚' },
  { id: 'single-daughter', kind: 'single', messages: alone('禾'), expected: [], mention: '禾' },
  { id: 'single-plumber-where', kind: 'single', messages: alone('砚现在在哪'), expected: [], mention: '砚' },
  { id: 'single-daughter-diet', kind: 'single', messages: alone('禾能吃什么'), expected: ['h05'] },
  { id: 'single-cat-where', kind: 'single', messages: alone('豆在哪'), expected: ['h25'] },
  { id: 'single-engineer-leg', kind: 'single', messages: alone('岚的腿怎么了'), expected: ['h01', 'h24'] },
  { id: 'single-navigator-after-scene', kind: 'single', messages: after(ENGINE, '鸦还活着吗？'), expected: ['h31'] },
  { id: 'single-cat-after-scene', kind: 'single', messages: after(GREENHOUSE, '豆今天吃东西了吗？'), expected: ['h25', 'h26'] },
  { id: 'single-daughter-after-scene', kind: 'single', messages: after(INFIRMARY, '禾最近还过敏吗？'), expected: ['h05', 'h04'] },

  // 焦点：最新输入问的是前文没有的事
  { id: 'focus-safe', kind: 'focus', messages: after(GREENHOUSE, '对了，保险柜的密码是多少？'), expected: ['h07'] },
  { id: 'focus-airlock', kind: 'focus', messages: after(ENGINE, '七号气闸现在能用吗？'), expected: ['h08'] },
  { id: 'focus-supply-ship', kind: 'focus', messages: after(INFIRMARY, '白鹭号下次什么时候到？'), expected: ['h12'] },
  { id: 'focus-backup-power', kind: 'focus', messages: after(GREENHOUSE, '备用电源能撑多久？'), expected: ['h16'] },
  { id: 'focus-blueprint', kind: 'focus', messages: after(INFIRMARY, '老K那份结构图要多少钱？'), expected: ['h30'] },
  { id: 'focus-sunrise-deck', kind: 'focus', messages: after(ENGINE, '日出舱为什么封了？'), expected: ['h29'] },

  // 前文：最新输入只是推进剧情
  { id: 'context-engine', kind: 'context', messages: after(ENGINE, '嗯，我不会说出去的。'), expected: ['h24', 'h19'] },
  { id: 'context-greenhouse', kind: 'context', messages: after(GREENHOUSE, '好，我去兑营养液。'), expected: ['h11', 'h25'] },
  { id: 'context-infirmary', kind: 'context', messages: after(INFIRMARY, '那我先走了。'), expected: ['h13', 'h14'] },
  { id: 'context-infirmary-denial', kind: 'context', messages: after(INFIRMARY, '没有，我什么都没看见。'), expected: ['h13', 'h14'] },

  // 混合：接着场景，同时带出新线索
  { id: 'mixed-smuggler', kind: 'mixed', messages: after(INFIRMARY, '柯文，你认识老K吗？'), expected: ['h14'] },
  { id: 'mixed-filter', kind: 'mixed', messages: after(ENGINE, '岚，砚那边的过滤芯是怎么回事？'), expected: ['h17'] },
  { id: 'mixed-strawberry', kind: 'mixed', messages: after(GREENHOUSE, '苏禾，小满最近还来拿草莓吗？'), expected: ['h19'] },

  // 无关
  { id: 'none-friday', kind: 'none', messages: alone('周五晚上有空吗'), expected: [] },
  { id: 'none-problem', kind: 'none', messages: alone('这道题怎么解'), expected: [] },
  { id: 'none-parcel', kind: 'none', messages: alone('帮我查一下快递'), expected: [] },
  { id: 'none-aircon', kind: 'none', messages: alone('空调温度调低一点'), expected: [] },
  { id: 'none-rent', kind: 'none', messages: alone('明天记得交房租'), expected: [] },
  { id: 'none-guitar', kind: 'none', messages: alone('我想学吉他'), expected: [] },
  { id: 'none-noodles', kind: 'none', messages: alone('楼下新开了一家面馆'), expected: [] },
  { id: 'none-tired', kind: 'none', messages: alone('今天好累啊'), expected: [] },

  // 换了说法：与记忆几乎没有共同字词
  { id: 'paraphrase-retire', kind: 'paraphrase', messages: alone('站长什么时候卸任'), expected: ['h06'] },
  { id: 'paraphrase-theft', kind: 'paraphrase', messages: alone('谁在偷药'), expected: ['h13'] },
  { id: 'paraphrase-weapon', kind: 'paraphrase', messages: alone('轮机长身上带武器吗'), expected: ['h15'] },
  { id: 'paraphrase-allergy', kind: 'paraphrase', messages: alone('那个小女孩不能碰什么食物'), expected: ['h05'] },
  { id: 'paraphrase-shutdown', kind: 'paraphrase', messages: alone('这里还能开多久'), expected: ['h27'] },
]
