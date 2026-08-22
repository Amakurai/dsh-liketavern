/**
 * 全局样式层：单一注入式样式表，收敛原来散落在 util/speech/hero/actions/seatChip 的 5 处 STYLE 块。
 * 颜色/阴影/动效一律走宿主 --dsw-* / --ds-* 令牌（每条带字面量兜底，防旧版宿主缺变量）。
 * 模块加载即注入一次（幂等）；组件文件 import './styles.js' 即可。
 */
const STYLE_ID = 'dsh-tavern-ui-style';
const STYLE = `
/* ========== 基础 ========== */
.dsh-tavern-ui{color:var(--dsw-alias-label-primary, inherit);color-scheme:inherit}
.dsh-tavern-panel{max-width:760px}
.dsh-tavern-ui ::selection{background:var(--dsw-alias-bg-multi-select, rgba(84,85,87,.55));color:var(--dsw-alias-label-primary, #fff)}
.dsh-tavern-ui input,.dsh-tavern-ui textarea,.dsh-tavern-ui select{
  color:var(--dsw-alias-label-primary, CanvasText);
  background:var(--dsw-alias-bg-layer-2, Field);
  color-scheme:inherit;
}
.dsh-tavern-ui select option,.dsh-tavern-ui option{
  color:var(--dsw-alias-label-primary, CanvasText);
  background:var(--dsw-alias-bg-layer-2, Field);
}

/* ========== 动效（时长/曲线走宿主档位） ========== */
@keyframes dsh-tavern-fade-up{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dsh-tavern-spin{to{transform:rotate(360deg)}}
@keyframes dsh-tavern-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.dsh-tavern-rise{animation:dsh-tavern-fade-up var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-spin{display:inline-flex;animation:dsh-tavern-spin .9s linear infinite}
@media (prefers-reduced-motion: reduce){
  .dsh-tavern-ui *,.dsh-tavern-ui *::before,.dsh-tavern-ui *::after{
    animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
}

/* ========== 可访问性 ========== */
.dsh-tavern-ui button:focus-visible,.dsh-tavern-ui [role="button"]:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:2px}
.dsh-tavern-ui input:focus-visible,.dsh-tavern-ui textarea:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:-1px;border-color:transparent}

/* ========== 滚动区（对齐宿主 8px 滚动条皮肤） ========== */
.dsh-tavern-scroll{scrollbar-width:thin;
  scrollbar-color:var(--dsh-scrollbar-thumb, var(--dsw-alias-border-l3, rgba(128,128,128,.4))) transparent}
.dsh-tavern-scroll::-webkit-scrollbar{width:8px;height:8px}
.dsh-tavern-scroll::-webkit-scrollbar-thumb{
  background:var(--dsh-scrollbar-thumb, var(--dsw-alias-border-l3, rgba(128,128,128,.4)));border-radius:4px}
.dsh-tavern-scroll::-webkit-scrollbar-thumb:hover{
  background:var(--dsh-scrollbar-thumb-hover, var(--dsw-alias-border-l4, rgba(128,128,128,.55)))}
.dsh-tavern-scroll::-webkit-scrollbar-track{background:transparent}

/* ========== 面板骨架 ========== */
.dsh-tavern-section{display:flex;flex-direction:column;gap:12px;margin-bottom:8px}
.dsh-tavern-pageTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-pageIntro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary, inherit)}
.dsh-tavern-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:4px}
.dsh-tavern-groupHead{margin:16px 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary, inherit)}
.dsh-tavern-groupHead:first-child{margin-top:0}

/* 页签：下划线式，激活时下划线 scaleX 淡入 */
.dsh-tavern-tabs{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px;margin:4px 0 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-tab{appearance:none;position:relative;margin:0;padding:7px 1px 9px;border:0;background:0 0;
  font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary, inherit);cursor:pointer;
  transition:color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-tab:hover,.dsh-tavern-tab[data-active="true"]{color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-tab:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;
  background:var(--dsw-alias-label-primary, currentColor);transform:scaleX(0);
  transition:transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-tab[data-active="true"]:after{transform:scaleX(1)}

/* ========== 设置行（对齐通用设置：标题 + 说明 + 右侧胶囊控件） ========== */
.dsh-tavern-row{display:flex;align-items:center;gap:8px;padding:16px 0;
  border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-row:last-child{border-bottom:none}
.dsh-tavern-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.dsh-tavern-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit)}
.dsh-tavern-rowControl{flex:none;min-width:0}
.dsh-tavern-rowControl .dsh-tavern-select{width:240px}
.dsh-tavern-row.is-stacked{flex-direction:column;align-items:stretch}
.dsh-tavern-row.is-stacked .dsh-tavern-rowText{padding-right:0}
.dsh-tavern-row.is-stacked .dsh-tavern-rowControl{width:100%}
.dsh-tavern-row.is-stacked .dsh-tavern-rowControl .dsh-tavern-select{width:100%}

/* ========== 卡片与列表 ========== */
/* 通用卡片容器（预设/人设的内联编辑卡等）；网格版海报卡与瓦片行见后文专节 */
.dsh-tavern-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);min-width:0;
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-card:hover{border-color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-card.is-clickable{cursor:pointer}
/* 可点卡片 hover 轻抬升一像素 + 一层浅阴影，:active 落回，给出「这张卡能点」的物理反馈 */
.dsh-tavern-card.is-clickable:hover,.dsh-tavern-card.is-clickable:focus-visible{
  transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-card.is-clickable:active{transform:none;box-shadow:none}
.dsh-tavern-card.is-selected{border-color:var(--dsw-alias-label-primary, #888)}
.dsh-tavern-cardName{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;
  color:var(--dsw-alias-label-primary, inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-badge{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border-radius:999px;
  font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary, inherit);
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-badge.is-accent{color:var(--dsw-alias-label-primary, inherit);
  border-color:var(--dsw-alias-label-dimmed, #bbb6)}
.dsh-tavern-badge.is-danger{color:var(--dsw-alias-state-error-primary, #ec1313);
  border-color:var(--dsw-alias-state-error-primary, #ec1313)}
.dsh-tavern-list{display:flex;flex-direction:column;gap:8px}
.dsh-tavern-listRow{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-listRow:hover{border-color:var(--dsw-alias-label-dimmed, #888)}

/* 空态（对齐宿主空态：圆底图标 + 标题 + 说明）；is-compact 用于页签内小空态 */
.dsh-tavern-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 16px;text-align:center}
.dsh-tavern-empty.is-compact{padding:24px 12px}
.dsh-tavern-emptyIcon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;margin-bottom:4px;
  border-radius:50%;background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
  color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-emptyTitle{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-emptyDesc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary, inherit)}

/* ========== 头像（img 或首字符 fallback，不再是灰块） ========== */
.dsh-tavern-avatar{width:var(--tavern-avatar-s, 40px);height:var(--tavern-avatar-s, 40px);flex:none;
  border-radius:28%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2));color:var(--dsw-alias-label-secondary, inherit);
  font-size:calc(var(--tavern-avatar-s, 40px) * .42);font-weight:500;line-height:1;user-select:none}
.dsh-tavern-avatar>img{width:100%;height:100%;object-fit:cover;display:block}

/* ========== 控件 ========== */
.dsh-tavern-file{display:inline-flex}
.dsh-tavern-select{display:block;width:100%;min-width:0;max-width:100%}
.dsh-tavern-select > span{display:block;width:100%}
/* 36px 胶囊选择器（对齐通用设置的 .selector） */
.dsh-tavern-pillSelect{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;
  width:100%;min-width:0;height:36px;padding:0 14px;border:0;border-radius:18px;cursor:pointer;text-align:left;
  background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary, inherit);font:inherit;font-size:14px;line-height:22px;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-pillSelect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18))}
.dsh-tavern-pillSelect:disabled{opacity:.4;cursor:default}
.dsh-tavern-pillSelect.is-sm{height:28px;padding:0 10px;border-radius:14px;font-size:13px;line-height:20px}
.dsh-tavern-pillSelectLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-pillSelectChevron{flex:none;color:var(--dsw-alias-label-caption, #888);
  transition:transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-pillSelect[aria-expanded="true"] .dsh-tavern-pillSelectChevron{transform:rotate(180deg)}

.dsh-tavern-toggle{appearance:none;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:20px;
  background:var(--dsw-alias-border-l4, rgba(128,128,128,.35));cursor:pointer;
  transition:background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-toggle.is-on{background:var(--dsw-alias-label-primary, #fff)}
.dsh-tavern-toggle:disabled{opacity:.4;cursor:default}
.dsh-tavern-toggle:after{content:"";display:block;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-bg-base, #111);
  transition:transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-toggle.is-on:after{transform:translateX(16px)}

/* 28px 圆形幽灵图标钮（对齐宿主消息操作钮） */
.dsh-tavern-iconBtn{width:28px;height:28px;padding:6px;border:none;border-radius:28px;display:inline-flex;
  align-items:center;justify-content:center;background:0 0;cursor:pointer;
  color:var(--dsw-alias-label-tertiary, inherit);
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-iconBtn.is-danger:hover{color:var(--dsw-alias-state-error-primary, #ec1313);
  background:var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.06))}
.dsh-tavern-iconBtn:disabled{opacity:.4;cursor:default;background:0 0}

/* 搜索框（36px 胶囊 + 前导图标） */
.dsh-tavern-search{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:36px;padding:0 12px;
  border-radius:18px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-2, transparent)}
.dsh-tavern-search:focus-within{border-color:var(--dsw-alias-state-business-primary, #4176e6)}
.dsh-tavern-search input{flex:1;min-width:0;border:0;background:transparent;padding:0;font:inherit;font-size:13px;
  outline:none;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-search input:focus-visible{outline:none}
.dsh-tavern-search input::placeholder{color:var(--dsw-alias-label-caption, #888)}
.dsh-tavern-searchIcon{flex:none;color:var(--dsw-alias-label-tertiary, inherit)}
/* 行内文字按钮（空结果态的「清空搜索」等）：继承正文色 + 下划线提示可点 */
.dsh-tavern-linkBtn{appearance:none;border:0;background:0 0;padding:0;font:inherit;font-size:inherit;line-height:inherit;
  color:var(--dsw-alias-label-secondary, inherit);cursor:pointer;text-decoration:underline;
  text-underline-offset:2px}
.dsh-tavern-linkBtn:hover{color:var(--dsw-alias-label-primary, inherit)}

/* 筛选 chip 行 */
.dsh-tavern-filters{display:flex;flex-wrap:wrap;gap:8px}
.dsh-tavern-chip{appearance:none;height:28px;padding:0 12px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:transparent;color:var(--dsw-alias-label-secondary, inherit);font:inherit;font-size:12px;cursor:pointer;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))}
.dsh-tavern-chip[data-active="true"]{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary, inherit);border-color:var(--dsw-alias-label-dimmed, #888)}
/* 多选 chip（CheckChips）：选中时前缀对勾，与单选筛选 chip 区分 */
.dsh-tavern-chip.is-check[data-active="true"]:before{content:'✓\u00a0';font-weight:600}

/* 段控（Pill 组，如 记忆/世界状态 切换） */
.dsh-tavern-segRow{display:flex;flex-wrap:wrap;align-items:center;gap:4px}

/* ========== 角色海报卡（封面 + 底部渐变名条） ========== */
.dsh-tavern-charGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin:0;padding:0;list-style:none}
.dsh-tavern-charCard{position:relative;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;min-width:0;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover,.dsh-tavern-charCard:focus-visible{
  border-color:var(--dsw-alias-label-dimmed, #888);
  transform:translateY(-2px);box-shadow:var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.04))}
.dsh-tavern-charCard:active{transform:none;box-shadow:none}
/* overflow:hidden 会裁掉全局 focus 轮廓，内缩到卡内 */
.dsh-tavern-charCard:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:-2px}
.dsh-tavern-charCardCover{position:relative;height:148px;flex:none;overflow:hidden;
  background:linear-gradient(135deg,
    var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)),
    var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)))}
.dsh-tavern-charCardCover>img{width:100%;height:100%;object-fit:cover;display:block;
  transition:transform .3s var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover .dsh-tavern-charCardCover>img,.dsh-tavern-charCard:focus-visible .dsh-tavern-charCardCover>img{transform:scale(1.04)}
.dsh-tavern-charCardInitial{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding-bottom:26px;
  font-size:44px;font-weight:600;color:var(--dsw-alias-label-dimmed, #888);user-select:none}
/* 名条压在封面底部渐变上；渐变同时压暗图片和浅色兜底封面，明暗主题下白字都可读 */
.dsh-tavern-charCardBar{position:absolute;left:0;right:0;bottom:0;padding:30px 12px 9px;min-width:0;
  display:flex;flex-direction:column;gap:1px;
  background:linear-gradient(to top, rgba(15,15,15,.82), rgba(15,15,15,0))}
.dsh-tavern-charCardName{font-size:14px;font-weight:600;line-height:20px;color:#fff;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-charCardMeta{font-size:12px;line-height:16px;color:rgba(255,255,255,.78);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-charCardActions{position:absolute;top:8px;right:8px;display:flex;gap:4px;opacity:0;
  transition:opacity var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover .dsh-tavern-charCardActions,.dsh-tavern-charCard:focus-within .dsh-tavern-charCardActions{opacity:1}
/* 封面上的操作钮：暗底玻璃感，图片与浅色封面上都可读 */
.dsh-tavern-coverBtn{width:28px;height:28px;padding:6px;border:none;border-radius:999px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  background:rgba(20,20,20,.55);color:#fff;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-coverBtn:hover{background:rgba(20,20,20,.78)}
.dsh-tavern-coverBtn.is-danger:hover{background:var(--dsw-alias-state-error-primary, #ec1313)}
.dsh-tavern-coverBtn:disabled{opacity:.4;cursor:default}

/* ========== 资产瓦片（世界书 / 预设 / 人设的一行式条目） ========== */
.dsh-tavern-tile{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;min-width:0;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-tile:hover,.dsh-tavern-tile:focus-visible{
  border-color:var(--dsw-alias-label-dimmed, #888);
  transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-tile:active{transform:none;box-shadow:none}
.dsh-tavern-tileIcon{width:38px;height:38px;flex:none;border-radius:10px;
  display:inline-flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-tileMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-tavern-tileTitleRow{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-tavern-tileName{min-width:0;font-size:14px;font-weight:500;line-height:20px;
  color:var(--dsw-alias-label-primary, inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-tileSub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-tileActions{display:flex;flex:none;align-items:center;gap:2px}

/* ========== 输入类（组件内 class 版；旧 inline style 对象逐步退场） ========== */
.dsh-tavern-input{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-layer-2, transparent);color:var(--dsw-alias-label-primary, inherit);
  border-radius:8px;padding:3px 8px;font-size:12px;color-scheme:inherit}
.dsh-tavern-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:90px;padding:8px 10px;
  font-size:13px;line-height:20px;font-family:inherit}
.dsh-tavern-codeFont{font-family:var(--ds-font-family-code, 'SF Mono', Consolas, monospace)}

/* ========== 世界书条目 accordion ========== */
.dsh-tavern-entry{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);border-radius:12px;overflow:hidden;
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    opacity var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-entry.is-open{background:var(--dsw-alias-bg-layer-2, transparent);
  border-color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-entry.is-off .dsh-tavern-entryTitle{opacity:.55}
.dsh-tavern-entryHead{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:0;
  background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-entryHead:hover{background:var(--dsw-alias-interactive-bg-hover, transparent)}
.dsh-tavern-entryMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-tavern-entryTitle{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-entrySub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-entryBadges{display:flex;flex:none;align-items:center;gap:6px}
.dsh-tavern-chevron{flex:none;color:var(--dsw-alias-label-tertiary, inherit);
  transition:transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-chevron.is-open{transform:rotate(180deg)}
.dsh-tavern-entryBody{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}
/* 展开/收起动画容器（grid-rows 手法，内容始终渲染） */
.dsh-tavern-collapse{display:grid;grid-template-rows:0fr;
  transition:grid-template-rows var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-collapse.is-open{grid-template-rows:1fr}
.dsh-tavern-collapseInner{overflow:hidden;min-height:0}

/* ========== 表单 ========== */
.dsh-tavern-field{display:flex;flex-direction:column;gap:6px;min-width:0;margin-bottom:10px}
.dsh-tavern-fieldLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary, inherit)}
/* 编辑器头部的元信息行：说明文字 + 状态徽标（如「未保存」）并排 */
.dsh-tavern-editorMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-tavern-field .dsh-tavern-input,.dsh-tavern-field .dsh-tavern-select,.dsh-tavern-field textarea{
  width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.dsh-tavern-fieldRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.dsh-tavern-fieldRow .dsh-tavern-field{margin-bottom:0}
.dsh-tavern-inlineChecks{display:flex;flex-wrap:wrap;gap:12px 16px;font-size:13px;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-inlineChecks label{display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.dsh-tavern-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:4px 0}
.dsh-tavern-stickyBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0 4px;
  border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))}

/* ========== 弹窗 ========== */
.dsh-tavern-modalActions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.dsh-tavern-modal-md{width:min(520px, calc(100vw - 32px));max-width:100%}
.dsh-tavern-modal-lg{width:min(680px, calc(100vw - 32px));max-width:100%}
.dsh-tavern-modal-xl{width:min(880px, calc(100vw - 32px));max-width:100%}
/* 弹窗内的分组面板卡：给密集表单一个有呼吸感的区块结构 */
.dsh-tavern-dialogStack{display:flex;flex-direction:column;gap:14px;min-width:0}
.dsh-tavern-panelCard{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent)}
.dsh-tavern-panelCard>.dsh-tavern-groupHead{margin:0}
.dsh-tavern-panelCard .dsh-tavern-field{margin-bottom:0}
.dsh-tavern-panelCard .dsh-tavern-bindingActions{margin-bottom:0}
/* 弹窗底部主操作行：危险/次要靠左，主操作靠右，撑满弹窗宽 */
.dsh-tavern-footActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-tavern-footSpacer{flex:1}
/* 上下文用量信息条：弱底色条带，进度条 + 文字 */
.dsh-tavern-usageBar{display:flex;flex-direction:column;gap:4px;padding:10px 14px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}
.dsh-tavern-usageBar .dsh-tavern-meter{margin:0}
/* 滚动区在 content 层（Modal 指定的 scrollable content region），钉在视口内；
   100vh - 72px = 视口减 root 上下 padding(48) 与 dialog 底部 padding(24)。
   body 不再各自限高，避免嵌套滚动。 */
.dsh-tavern-modalContent{max-height:calc(100vh - 72px);overflow:auto}
.dsh-tavern-modalBody{min-width:0}
.dsh-tavern-modalPre{white-space:pre-wrap;font-size:12px;line-height:18px;max-height:60vh;overflow:auto;margin:0}
.dsh-tavern-binding{display:flex;flex-direction:column;gap:14px;min-width:0}
.dsh-tavern-bindingActions{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}

/* ========== 文本反馈 ========== */
.dsh-tavern-errText{color:var(--dsw-alias-state-error-primary, #ec1313);font-size:12px;line-height:18px;margin:6px 0}
.dsh-tavern-muted{color:var(--dsw-alias-label-tertiary, inherit);opacity:.85;font-size:12px;line-height:18px}
.dsh-tavern-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);padding:4px 0}
/* 上下文用量细进度条：轨道用二层底，填充默认主题蓝，≥90% 转错误色提示接近打满 */
.dsh-tavern-meter{height:4px;border-radius:2px;overflow:hidden;margin:2px 0 6px;
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}
.dsh-tavern-meterFill{display:block;height:100%;border-radius:2px;min-width:2px;
  background:var(--dsw-alias-state-business-primary, #4176e6);
  transition:width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-meterFill[data-warn="true"]{background:var(--dsw-alias-state-error-primary, #ec1313)}

/* ========== 骨架屏 ========== */
.dsh-tavern-skeleton{border-radius:6px;
  background:linear-gradient(90deg,
    var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)) 25%,
    var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)) 50%,
    var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)) 75%);
  background-size:200% 100%;animation:dsh-tavern-shimmer 1.4s linear infinite}

/* ========== 记忆 / 世界状态条目 ========== */
.dsh-tavern-memo{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-memo:hover{border-color:var(--dsw-alias-label-dimmed, #888)}
/* 已撤销的世界状态整体压暗，只留可读性 */
.dsh-tavern-memo.is-revoked{opacity:.62}
/* 新增表单卡：虚线边框示意「往里添东西」 */
.dsh-tavern-memo.is-compose{border-style:dashed;background:transparent}
.dsh-tavern-memo.is-compose:hover{border-color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-memoHead{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-tavern-memoMeta{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-memoBody{margin:0;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;
  max-height:140px;overflow:auto;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-memoActions{display:flex;align-items:center;gap:4px}

/* ========== 聊天发言条 ========== */
.dsh-tavern-speech{display:flex;gap:12px;align-items:flex-start;width:100%;min-width:0;position:relative;
  color:var(--dsw-alias-label-primary, inherit)}
/* 气泡右上角复制钮：默认收起，hover / 键盘聚焦时浮现 */
.dsh-tavern-speechCopy{position:absolute;top:-2px;right:0;opacity:0;
  transition:opacity var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-speech:hover .dsh-tavern-speechCopy,.dsh-tavern-speech:focus-within .dsh-tavern-speechCopy{opacity:1}
.dsh-tavern-speechAvatar{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));box-sizing:border-box}
.dsh-tavern-speechBody{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.dsh-tavern-speechName{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-speechHtml{width:100%;min-height:280px;height:min(72vh,880px);overflow:auto;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));border-radius:16px;
  background:var(--dsw-alias-bg-base, #111);display:block;box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-speechHtml.is-widget{min-height:0;height:280px;overflow:auto;background:transparent;border:none;box-shadow:none}
.dsh-tavern-reason{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary, inherit);min-width:0}
.dsh-tavern-reason>summary{cursor:pointer;user-select:none;list-style:none;padding:4px 0;border-radius:6px;
  transition:color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-reason>summary:hover{color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-reason>summary::-webkit-details-marker{display:none}
.dsh-tavern-reason>summary::before{content:'▸ ';opacity:.7}
.dsh-tavern-reason[open]>summary::before{content:'▾ '}
.dsh-tavern-reason pre{white-space:pre-wrap;margin:6px 0 0;font-size:12px;line-height:18px;opacity:.9;
  max-height:40vh;overflow:auto}

/* ========== 楼层操作条 ========== */
.dsh-tavern-action{width:28px;height:28px;padding:6px;border:none;border-radius:28px;display:inline-flex;
  align-items:center;justify-content:center;background:0 0;cursor:pointer;
  color:var(--dsw-alias-label-tertiary, inherit);
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-action:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-action:disabled{cursor:default;opacity:.4;background:0 0}
.dsh-tavern-actionGroup{margin-left:auto;display:inline-flex;align-items:center;gap:2px}
/* 组间细竖线：兄弟导航 ‹ n/m ›、开场白 swipe、楼层操作三组之间的视觉分界 */
.dsh-tavern-actionDivider{flex:none;width:1px;height:16px;margin:0 6px;
  background:var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-swipeIdx{font-size:12px;line-height:18px;padding:1px 8px;border-radius:999px;text-align:center;
  color:var(--dsw-alias-label-tertiary, inherit);background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}

/* ========== 座位芯片（会话头部 + 英雄区选角） ========== */
.dsh-tavern-seat{max-width:min(100%,240px);min-height:28px;color:var(--dsw-alias-label-primary, inherit);
  white-space:nowrap;text-overflow:ellipsis;cursor:pointer;background:0 0;border:none;border-radius:16px;
  align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;overflow:hidden;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-seat:not(:disabled):hover,.dsh-tavern-seat[aria-expanded=true]{
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))}
.dsh-tavern-seat:disabled{cursor:default;color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-seatIcon{color:var(--dsw-alias-label-primary, inherit);flex:none;display:inline-flex;align-items:center}
.dsh-tavern-seatLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dsh-tavern-seatChevron{color:var(--dsw-alias-label-caption, #888);flex:none;
  transition:transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-seat[aria-expanded=true] .dsh-tavern-seatChevron{transform:rotate(180deg)}

/* ========== 英雄区（新会话选卡 + 开场白预览） ========== */
[data-tavern-hero-seat]{display:inline-flex;flex:none;align-items:center}
.dsh-tavern-hero-preview{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance, 16px) * 2);
  max-width:var(--dsh-chat-content-width, 748px);margin:6px auto 0;padding:12px 14px;border-radius:16px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, transparent));
  box-shadow:var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.04));
  color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-hero-preview:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:2px}
.dsh-tavern-hero-previewHead{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-tavern-hero-previewHeadText{min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-tavern-hero-previewName{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-hero-previewMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption, #888);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-hero-previewText{margin-top:8px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary, inherit);
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
/* 开场白正文：左侧引用竖线 + 保留换行，读起来像角色在说话 */
.dsh-tavern-hero-quote{margin-top:10px;padding-left:12px;
  border-left:2px solid var(--dsw-alias-border-l3, rgba(128,128,128,.4));
  font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary, inherit);white-space:pre-wrap;
  display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsh-tavern-hero-swipe{display:inline-flex;align-items:center;gap:4px;margin-top:8px}
.dsh-tavern-hero-swipeHint{margin-left:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption, #888)}
.dsh-tavern-hero-swipeBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary, inherit);cursor:pointer;
  background:0 0;border:none;border-radius:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-hero-swipeBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-hero-swipeBtn:disabled{cursor:default;opacity:.4}
.dsh-tavern-hero-swipeIdx{font-size:12px;color:var(--dsw-alias-label-caption, #888);min-width:32px;text-align:center}
.dsh-tavern-hero-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.dsh-tavern-hero-actions .dsh-tavern-hero-swipe{margin-left:auto;margin-top:0}
.dsh-tavern-hero-error{color:var(--dsw-alias-state-error-primary, #ec1313);font-size:12px;
  max-width:var(--dsh-chat-content-width, 748px);margin:0 auto 8px;padding:0 var(--dsh-composer-side-clearance, 16px)}
`;
/** 幂等注入全局样式表（模块加载即执行一次）。 */
export function ensureTavernStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = STYLE;
    document.head.appendChild(el);
}
ensureTavernStyles();
