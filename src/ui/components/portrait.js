/* ══════════════════════════════════════════════════════════════════════════
   portrait.js — 三个 Agent 的内联肖像 SVG
   ──────────────────────────────────────────────────────────────────────────
   手写线性 SVG，零外部图片（design-token §8 / Stage-0 附录 B）。
   颜色一律 currentColor，由所在容器的 --accent-base 决定。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var COMMON = 'viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" role="img"';

  var KINDS = {
    /* 烬：火柴与烛形火苗 —— 对应 dice（擦火柴）*/
    flame: {
      label: '烬的肖像',
      body:
        '<path d="M32 7c5 9 3 12 .6 16C30.4 26.6 27 30 27 35a9 9 0 0 0 18 0c0-6-4-9-6-13-2-5-4-9-7-15z"/>' +
        '<path d="M32 34c-2.2 3-1 6.4 1.2 7.6"/>' +
        '<path d="M20 56h24"/>'
    },
    /* 棱镜：入射光在三角棱镜上折成三束 —— 对应 wiki_lookup（折光）*/
    prism: {
      label: '棱镜的肖像',
      body:
        '<path d="M32 11 55 49H9z"/>' +
        '<path d="M4 30h14"/>' +
        '<path d="M41 37l16-5M42 41l16 5M41 45l14 13"/>'
    },
    /* 薇奥拉：一笔未收的曲线与散落的光点 —— 对应 inspo_seed（飘散的字）*/
    stroke: {
      label: '薇奥拉的肖像',
      body:
        '<path d="M6 46c8-16 14 2 22-10S42 15 58 11"/>' +
        '<path d="M16 22v6M13 25h6"/>' +
        '<circle cx="47" cy="41" r="1.8" fill="currentColor" stroke="none"/>' +
        '<circle cx="55" cy="29" r="1.3" fill="currentColor" stroke="none"/>'
    }
  };

  var Portrait = {
    name: 'Portrait',
    props: {
      kind: { type: String, required: true }
    },
    computed: {
      svg: function () {
        var k = KINDS[this.kind] || KINDS.flame;
        return '<svg ' + COMMON + ' aria-label="' + k.label + '">' + k.body + '</svg>';
      }
    },
    template: '<span class="portrait" v-html="svg" aria-hidden="false"></span>'
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.UI = global.Tavern.UI || {};
  global.Tavern.UI.Portrait = Portrait;
  global.Tavern.UI._KINDS = Object.keys(KINDS);
})(window);
