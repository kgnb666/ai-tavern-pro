/* ══════════════════════════════════════════════════════════════════════════
   mock-scripts.js — MockProvider 的剧本内容（数据层，无逻辑）
   ──────────────────────────────────────────────────────────────────────────
   全部文案为模拟内容，仅在 kind:'mock' 的 Provider 下使用；任何展示它的位置
   都必须带 MOCK 标识（Stage 1-2 硬性要求）。

   槽位由 MockProvider 用**真实数据**填充：
     {topic}       用户本轮输入（截断）
     {topicShort}  用户输入（更短）
     {memLine}     记忆命中时的真实引用 / 未命中时的诚实说明
     {firstAction} 来自本轮真实生成的计划对象
     {image}       来自本次真实随机抽到的意象
     {seeds}       同上，词列表

   人格一致性由 persona-spec.md 约束：签名符号每轮最多一次、不超过 6 段、不堆感叹号。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── 回复剧本：agentId → 分支（action=规划决策类 / inform=知识类 / chat=闲聊） ── */

  var REPLIES = {
    bartender: {
      action: [
        '先擦根火柴 — 关于「{topic}」，我只给一个判断，不给你三个选项。',
        '它值得做，前提是你把前两周压在最小可验证的那一步上。最坏的情况是方向对、手感不对，这个代价我建议你认。',
        '{memLine}今晚只做一件事：{firstAction}'
      ].join('\n\n'),
      inform: [
        '问我这个不太对路 — 你要的是查证，不是判断。',
        '不过如果你要的是「怎么判断这些信息靠不靠得住」，我可以给你一套筛子：先看它能不能被证伪，再看它有没有说清自己的适用边界。能过这两关的东西，才值得你拿它做决定。',
        '{memLine}要不要我把筛子列出来？'
      ].join('\n\n'),
      chat: [
        '今晚想聊什么都行。{memLine}',
        '要是没头绪，我先问你一件：这周有什么事你一直没开始？那件事通常比你以为的重要。'
      ].join('\n\n')
    },

    oracle: {
      action: [
        '你问的是怎么做，但我更擅长告诉你「关键变量是什么」。',
        '「{topic}」这件事上，能左右结果的一般只有两个变量：你愿意投入多少时间，以及你打算拿什么当验证信号。其余的多半是噪音 ~',
        '{memLine}'
      ].join('\n\n'),
      inform: [
        '先说我能确定的那一半：{topic} 这件事，我能给的是框架，不是结论。',
        '我没能查到来源（这一轮我没有联网检索），所以下面这段是凭我已有的印象说的，可能不准 ~ 卡片里我把不确定的部分都标出来了。',
        '{memLine}要不要我换个角度，从相邻的概念往回推一遍？'
      ].join('\n\n'),
      chat: [
        '我在。你可以随口问，我会告诉你我确定哪一半。',
        '{memLine}灯亮着的时候我比较看得清东西。'
      ].join('\n\n')
    },

    muse: {
      action: [
        '先来三个，都不负责 — 都在卡片上，你挑一个方向，我再往深里推。',
        '{memLine}嫌它们太乖的话，我换个野一点的 *'
      ].join('\n\n'),
      inform: [
        '解释类的东西我容易说糊，我更喜欢给你一个例子。',
        '「{topic}」在我脑子里的画面是：{image}。',
        '要是这个画面不对，你告诉我哪里不对，我换一张 *'
      ].join('\n\n'),
      chat: [
        '别问为什么，先听一遍 — 我今晚手上有几个词：{seeds}。',
        '你随便挑一个，我给你三样东西 *'
      ].join('\n\n')
    }
  };

  /* ── 卡片剧本（字段严格取自 persona-spec §2.7 / §3.7 / §4.7） ─────── */

  var CARDS = {
    bartender: {
      v: 1,
      type: 'plan',
      title: '把「{topicShort}」推到可验证的一步',
      horizon: 'week',
      steps: [
        { id: 's1', text: '把目标写成一个两周内能判定的结果', est: '30min', why: '不可判定的目标没法验证', done: false },
        { id: 's2', text: '找到能证明方向对的最小动作', est: '1h', why: '先要信号，不要规模', done: false },
        { id: 's3', text: '留一次复盘：哪里手感不对', est: '30min', why: '偏差要早发现', done: false }
      ],
      risks: ['前三天最容易掉队'],
      firstAction: '今晚只做一件事：把目标写成一句话；写不出来，就先写「做完之后你会看到什么」',
      basis: '{basis}',
      checkable: true
    },

    oracle: {
      v: 1,
      type: 'knowledge',
      question: '{topicShort}',
      summary: '框架比结论更耐用：先把「已知 / 可推 / 未知」分开。',
      points: [
        { claim: '这类问题的关键变量通常只有两个：投入强度与验证信号', confidence: 0.55, source: null },
        { claim: '相邻概念的边界，往往比概念本身更容易说清', confidence: 0.5, source: null }
      ],
      uncertainties: [
        '这一轮我没有联网检索，无法给出来源与时效性',
        '我的印象可能停留在较早的资料上，请自行复核关键事实'
      ],
      sourcesOk: false,
      followUp: '要不要我把“不确定”的那两条单独展开讲？'
    },

    muse: {
      v: 1,
      type: 'inspiration',
      prompt: '{topicShort}',
      styleTags: ['冷', '金属感'],
      variants: [
        { id: 'v1', tag: '直白派', text: '「{topicShort}」，把多余的字都删掉，只留下动作。', imagery: ['雨', '霓虹'] },
        { id: 'v2', tag: '反向派', text: '先写「{topicShort}」的反面，看看哪一边更像真的。', imagery: ['锈', '回声'] },
        { id: 'v3', tag: '多余派', text: '给「{topicShort}」加一个不该有的限制，比如只能用三个字。', imagery: ['雾', '账本'] }
      ],
      constraints: [],
      seed: { seedId: 'sd_mock', words: ['铁锈', '回声'], image: '一块熄掉很久的招牌' },
      canRegenerate: true
    }
  };

  /* ── 记忆未命中时的诚实说明（不得编造记忆，persona-spec 红线 U1） ──── */

  var MEMORY_LINES = {
    hit: '你前面说过「{memory}」，我记着。',
    missFirst: '我们才刚认识，我手上关于你的东西还不多 — 你再聊两句，我就能记住点东西。',
    missNone: '我翻了一遍你的话，没找到和这次相关的 — 我手上只有这些。'
  };

  /* ── 意象/种子词库（真实随机抽取，不是预设句子） ───────────────────── */

  var SEED_WORDS = ['铁锈', '回声', '雾', '账本', '霓虹', '打烊', '硬币', '旧磁带', '雾灯', '半张票根', '熄灭的招牌', '反复擦的杯子'];
  var SEED_IMAGES = ['一块熄掉很久的招牌', '一杯没人接的凉水', '雨里的霓虹在积水里碎成两半', '柜台后面那盏一直在闪的灯', '抽屉里一叠过期的小票'];

  /* ── 开场句：点击标签即填入输入框（标签文案来自 persona-spec 的 DEMO_TOPICS） ──
     每句都刻意命中不同的意图分支，便于验证 MockProvider 的意图分类是真在工作。 */
  var STARTERS = {
    bartender: {
      '拆解目标': '帮我规划一下这个项目，先做哪一步',
      '两难选择': '我该不该换一个方向，我一直在纠结',
      '本周计划': '为什么我总是在开始前卡住'
    },
    oracle: {
      '概念追问': 'BPE 分词是什么，怎么理解它的原理',
      '来源与置信度': '我该不该信一份没写来源的资料',
      '知识边界': '你怎么判断一个概念值不值得学'
    },
    muse: {
      '命名': '给这个赛博酒馆起几个招牌名',
      '设定': '帮我想一个人物设定，酒馆老板的',
      '三个方向': '为什么我的点子看起来都很像'
    }
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.MockScripts = Object.freeze({
    STARTERS: Object.freeze(STARTERS),
    REPLIES: Object.freeze(REPLIES),
    CARDS: Object.freeze(CARDS),
    MEMORY_LINES: Object.freeze(MEMORY_LINES),
    SEED_WORDS: Object.freeze(SEED_WORDS.slice()),
    SEED_IMAGES: Object.freeze(SEED_IMAGES.slice())
  });
})(window);
