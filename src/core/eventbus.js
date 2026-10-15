/* ══════════════════════════════════════════════════════════════════════════
   eventbus.js — 类型化事件总线 + 冻结事件名契约
   ──────────────────────────────────────────────────────────────────────────
   事件名逐字来自 stage-0-architecture.md §2.4「Trace 事件契约」。
   本阶段（Stage 1）不产生任何真实事件，这里只做两件事：
     1. 把契约固化成常量，让后续 Mock / 真实引擎无法各自发明事件名；
     2. 提供 emit 白名单校验——发未知事件名会被拒绝并报错。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var TRACE_EVENTS = [
    'trace:turn:start',
    'trace:step',
    'trace:token',
    'trace:memory:hit',
    'trace:memory:write',
    'trace:tool:call',
    'trace:status',
    'trace:turn:end'
  ];

  var UI_EVENTS = [
    'ui:route',
    'ui:panel',
    'ui:toast'
  ];

  var KNOWN = Object.freeze(TRACE_EVENTS.concat(UI_EVENTS));
  var handlers = Object.create(null);

  function on(name, fn) {
    assertKnown(name);
    (handlers[name] || (handlers[name] = [])).push(fn);
    return function off() { remove(name, fn); };
  }

  function once(name, fn) {
    var off = on(name, function (payload) { off(); fn(payload); });
    return off;
  }

  function remove(name, fn) {
    var list = handlers[name];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function emit(name, payload) {
    assertKnown(name);
    var list = handlers[name];
    if (!list || !list.length) return 0;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try {
        copy[i](payload);
      } catch (err) {
        // 单个订阅者出错不得中断其他订阅者
        console.error('[EventBus] 订阅者异常 @ ' + name, err);
      }
    }
    return copy.length;
  }

  function assertKnown(name) {
    if (KNOWN.indexOf(name) === -1) {
      throw new Error(
        '[EventBus] 未知事件名 "' + name + '"。\n' +
        '允许的事件名由 stage-0-architecture.md §2.4 冻结；新增事件必须先改契约文档。'
      );
    }
  }

  var api = Object.freeze({
    TRACE_EVENTS: Object.freeze(TRACE_EVENTS.slice()),
    UI_EVENTS: Object.freeze(UI_EVENTS.slice()),
    KNOWN: KNOWN,
    on: on,
    once: once,
    off: remove,
    emit: emit,
    /** 供自检使用：当前订阅者数量 */
    count: function () {
      var n = 0;
      for (var k in handlers) n += handlers[k].length;
      return n;
    }
  });

  global.Tavern = global.Tavern || {};
  global.Tavern.EventBus = api;
})(window);
