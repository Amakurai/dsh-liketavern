/**
 * 功能词表：中文的功能字与功能 bigram，英文的功能词。
 *
 * 检索用的文档频率来自剧情自己的记忆库，库不大时分不出「没有」「什么」「the」这类功能词和真正的内容词——
 * 它们在几十条记忆里同样显得稀有，却不携带任何话题信息。这份表只在查询一侧使用：
 * 表里的字不作为单字词，功能 bigram 与英文功能词不参与评分。索引和写入去重不受影响。
 * 日文的功能词是假名（单个假名本来就不作单字词），假名 bigram 和韩文没有对应的表，仍只靠文档频率。
 *
 * 中文功能字分两类：
 * - 虚词（助词、代词、副词、连词、介词、能愿）：自己单独成词，所以也用来判断相邻的字是否处在词的边界上。
 * - 泛义字（趋向与泛义动词、方位时间、数量词、泛指名词）：同样不作单字词，但常与相邻的字合成一个词
 *   （今天、后面、一直、好听），不能当作边界。
 *
 * 功能 bigram 的判定比功能字窄得多。被剔除的 bigram 完全不参与检索，连其中的字也不再单独作证据，
 * 所以这里宁可漏掉一些噪声，也不能把名字和实词算进去：「两个字都是功能字」不是理由——
 * 日向、五月、千里、和也、天使、上将、天才、自由都由功能字组成。只剔除四种：
 * - 列在 STOP_BIGRAMS 里的功能词；
 * - 两个字都是核心虚词（结构助词、语气词、人称与指示代词、是不没也都就还又很在）：我们、什么、不是、也不；
 * - 结构助词或语气词与任意功能字相邻：的人、了一、好吗（这些字不构成名字）；
 * - 数词接量词：两个、几次、三张。
 * 其余由两个功能字组成的 bigram（来一、里有、是个，也包括上面那些名字）多半是跨词的碎片，
 * 但分不清，所以保留、只按半权重计（isWeakBigram）：名字照样搜得到，碎片带来的偶然命中减半。
 *
 * 取舍：不收任何常见的名字用字或具体名词；漏收的字和词只是退回到按文档频率处理。
 * 确实以表里的字或词作名字时，把它单独写成记忆的一个 key 即可照常检索。
 */
const PARTICLES = new Set([
    // 助词、语气词、叹词
    ...'的了着过得地之吗呢吧啊呀哦嗯哎唉啦嘛么呗咯哟呐诶唔哼嘿喂呃嗨哈呵噢咦哇罢',
    // 代词、指示词、疑问词
    ...'我你他她它您咱俺们己自这那哪谁何啥此其某另各每什怎',
    // 副词与否定
    ...'是有没不也都就还又再很太更最才只仅已曾将正刚便仍竟倒总常挺极颇稍略无未非别勿否均皆亦乃然乎尔尚甚岂莫毋咋倘况遂',
    // 连词
    ...'和与或及而且但却则因为以如若虽即既并',
    // 介词与使役
    ...'把被让使给对向从到于在比像跟同当往朝按据由等似',
    // 能愿与称谓动词
    ...'能会可要想该应须需敢肯叫',
]);
const GENERIC = new Set([
    // 趋向与泛义动词
    ...'去来起出进上下说看做用经',
    // 方位与时间泛称
    ...'里外前后中内边年月日天时',
    // 数词与通用量词
    ...'一二三四五六七八九十百千万两几多少第个些件条张块份位名次回种样点',
    // 泛指名词、程度与构词后缀（税务所、使者、一般）
    ...'人事大小好所者般',
]);
/** 引出名字的字：姓某、绰号某、人称某、唤作某。只在后面紧跟标点时才当作边界。 */
const NAMING_CUES = new Set([...'姓号称作']);
/** 结构助词与语气词：只附着在别的词上，不出现在名字和实词里。 */
const AFFIXES = new Set([...'的了着吗呢吧啊呀哦嗯啦嘛么']);
/** 核心虚词：两个相邻时必定是功能词或跨词的碎片（我们、不是、也不、在这），不会是名字。 */
const CORE = new Set([...AFFIXES, ...'我你他她它您咱俺们这那哪谁啥什怎是不没也都就还又很在']);
const NUMERALS = new Set([...'一二两三四五六七八九十百千万几每']);
/** 接在数词后面的通用量词。不收「条、种、月、日」：五条、九条、千种、五月、七月是常见的姓名。 */
const COUNTERS = new Set([...'个些次张件份位名块回点']);
/** 功能词；只列含有核心虚词以外的字、因而不能靠上面的规则判定的那些。 */
const STOP_BIGRAMS = new Set((
// 代词与指示
'自己 大家 别人 人家 其他 其它 其中 这个 那个 哪个 这些 那些 哪些 这样 那样 怎样 这种 那种 这里 那里 哪里 这儿 那儿 哪儿 ' +
    '这边 那边 这次 那次 这时 那时 此时 当时 有时 同时 有些 有点 有人 没人 一下 一样 一起 一直 一定 一切 一般 一旦 ' +
    // 否定与能愿
    '没有 可以 可能 应该 应当 需要 想要 能够 必须 不要 不想 不会 不能 不用 不敢 不可 不必 不过 不然 ' +
    // 系词与副词
    '只是 可是 但是 要是 于是 总是 正是 才是 真是 倒是 而是 还有 只有 所有 已经 曾经 正在 刚才 刚刚 马上 立刻 非常 十分 特别 比较 更加 ' +
    '也许 或许 大概 好像 似乎 居然 竟然 果然 忽然 突然 依然 仍然 当然 既然 虽然 其实 ' +
    // 连词
    '因为 所以 如果 假如 即使 尽管 无论 不管 只要 除非 否则 因此 而且 并且 或者 以及 不但 不仅 然后 然而 ' +
    // 趋向补语
    '起来 出来 进来 回来 过来 上来 下来 出去 进去 回去 过去 上去 下去 ' +
    // 时间泛称与疑问
    '现在 时候 以后 以前 之后 之前 后来 上次 下次 个月 多少 为何 如何 为什 ' +
    // 认知、言说与泛指
    '知道 觉得 认为 告诉 东西').split(' '));
/**
 * 英文功能词：冠词、代词、介词、连词、助动词、常见副词，以及否定缩写去掉词尾后剩下的词干（isn't → isn）。
 * 不收 will、may：它们同时是常见的人名。也不收单个字母：撇号拆出来的 s、t、d、m 在分词时就丢掉了，
 * 留在这里会连带剔掉以字母为名的角色（M、T 先生、小 S）。don、won 同理不收（Don 是人名，won 是实词）。
 */
const STOP_WORDS = new Set(('a an the and or but if so as of to in on at by for from with about into over than then that this these those there here ' +
    'i me my mine you your yours he him his she her hers it its we us our ours they them their theirs who whom whose what which when where why how ' +
    'am is are was were be been being do does did done have has had having would shall should can could might must ' +
    'not no nor yes ok okay oh well just very too also only even still yet any some each every all both either neither ' +
    'up down out off again once more most much many such own same other another ' +
    'isn aren wasn weren doesn didn hasn haven hadn wouldn shouldn couldn mustn needn ain').split(' '));
/** 功能字：不作为单字词。 */
export function isStopChar(char) {
    return PARTICLES.has(char) || GENERIC.has(char);
}
/** 虚词：自己单独成词，相邻的字在这一侧处于词的边界。 */
export function isSeparatorChar(char) {
    return PARTICLES.has(char);
}
export function isNamingCue(char) {
    return NAMING_CUES.has(char);
}
/** 功能 bigram：列表里的功能词、两个核心虚词、助词或语气词挨着功能字、数词接量词。 */
export function isStopBigram(term) {
    if (term.length !== 2)
        return false;
    const first = term[0];
    const second = term[1];
    return STOP_BIGRAMS.has(term)
        || (CORE.has(first) && CORE.has(second))
        || (AFFIXES.has(first) && isStopChar(second))
        || (isStopChar(first) && AFFIXES.has(second))
        || (NUMERALS.has(first) && COUNTERS.has(second));
}
/**
 * 两个字都是功能字、又不属于功能 bigram 的那些：多半是跨词的碎片（来一、里有），也可能是名字（日向、五月）。
 * 调用方应先用 isStopBigram 排除确定的功能词。
 */
export function isWeakBigram(term) {
    return term.length === 2 && isStopChar(term[0]) && isStopChar(term[1]);
}
/** 英文功能词；传入的词应已转小写。 */
export function isStopWord(term) {
    return STOP_WORDS.has(term);
}
