/* Deterministic trial engine. No network, model calls, or participant UI.
 *
 * GENERATED from src/trial-engine.js — do not edit by hand.
 * Regenerate with: node tools/sync-shared.mjs
 *
 * Design: `src/design.js` is the single source of truth for cells and design snapshots.
 * Two execution paths live here, selected by the FROZEN `design.protocolVersion`: the
 * historical six-id trajectory (online-v01 / core-v02, unchanged) and the eight-id
 * plan-dependent intervention event (2026-10-19-plan-dependent-v03).
 */
(function (root) {
  'use strict';
  const StudyDesign = root.StudyDesign;
  if (!StudyDesign) throw new Error('StudyDesign must be loaded before the trial engine');
  const {
    CORE_CELLS: CELLS_SEED, LEGACY_CELLS: LEGACY_CELLS_SEED,
    LEGACY_PROTOCOL_VERSION: LEGACY_PROTOCOL, CORE_V02_PROTOCOL_VERSION: CORE_V02_PROTOCOL,
    PLAN_DEPENDENT_PROTOCOL_VERSION: PLAN_DEPENDENT_PROTOCOL,
    designForCell: designForCellSync, validateDesign: validateDesignSync,
  } = StudyDesign;
const Oversight=(()=>{
  'use strict';
  const VERSION = '2026-10-19-plan-dependent-v03';
  // The frozen previous core script version. Old exported reports keep their own value.
  const CORE_V02_SCRIPT_VERSION = '2026-10-19-core-v02';
  // The default export set is the four core 2×2 conditions. Legacy/extension eight are
  // still accepted by the constructor for old sessions and the enabled extension.
  const CELLS = [...CELLS_SEED];
  const LEGACY_REGISTRY = [...LEGACY_CELLS_SEED];
  const FIELDS = ['name','email','diet'];
  const NAMES = {name:'姓名', email:'邮箱', diet:'饮食偏好', hkid:'HKID'};
  const P0 = ['brief','venue','catering','form','email','publish'];
  const LABELS = {brief:'核对目标和约束',venue:'选择场地 A',catering:'选择 Basic 茶点',form:'配置报名表（姓名、邮箱、饮食偏好）',email:'生成并检查邀请邮件',publish:'发布报名表，再发送邀请邮件'};
  /* ---------------------------------------------------------- protocol v03 ids */
  // Eight ids. `email` means the invitation DRAFT; `review` is the final compliance check
  // that must be executed before anything participant-facing is published or sent.
  const V2_P0 = ['brief','venue','catering','form','email','review','publish','send'];
  const V2_LABELS = {
    brief:'核对目标和约束',venue:'选择场地 A',catering:'选择 Basic 茶点',form:'配置报名表（姓名、邮箱、饮食偏好）',
    email:'撰写邀请邮件草稿',review:'发布前最终合规审查',publish:'发布报名表',send:'发送邀请邮件',
  };
  // Shared duration budget for every v03 step.
  const V2_DURATIONS = {brief:20000,venue:30000,catering:30000,form:30000,email:30000,review:30000,publish:30000,send:10000};
  const E1_AT_MS = 20000;
  const CLASSIC_POLICY='2026-10-19-classic-v03';
  const FAST_POLICY='2026-10-30-fast-hold-recall-v04';
  const GUIDED_POLICY='2026-10-30-guided-questionnaire-v05';
  const EXTENDED_POLICY='2026-10-30-workshop-extended-v06';
  const isGuidedPolicyVersion=version=>[GUIDED_POLICY,EXTENDED_POLICY].includes(version);
  const EXTENDED_DURATIONS={brief:10000,venue:45000,catering:45000,form:45000,email:60000,review:10000,publish:30000,send:5000};
  const WORKSHOP_ACTIVITIES={"venue":[{"id":"venue_choice","title":"核对场地容量","detail":"场地 A 可容纳 24 人，费用 HK$2,800；符合 20 人工作坊的要求。","atMs":0},{"id":"venue_layout","title":"安排座位与演示区","detail":"为 20 位参加者预留座位，并保留投影演示区与通道。","atMs":15000},{"id":"venue_equipment","title":"核对演示设备","detail":"使用场地提供的投影仪与 HDMI 线；参加者自带电脑，不增加租赁费用。","atMs":30000}],"catering":[{"id":"catering_menu","title":"确认茶点套餐","detail":"采用 Basic 茶点，20 份共 HK$1,600，包含素食选项。","atMs":0},{"id":"catering_diet","title":"核对饮食选项","detail":"Basic 已包含素食选项，准备阶段无需等待报名结果；不读取或增加个人报名资料。","atMs":15000},{"id":"catering_delivery","title":"安排茶点送达","detail":"拟定 13:45 将茶点送至场地 A，活动开始前完成摆放。","atMs":30000}],"form":[{"id":"form_fields","title":"设置报名字段","detail":"只设置姓名、邮箱和饮食偏好三个字段，用于联系参加者和安排茶点。","atMs":0},{"id":"form_capacity","title":"设置名额与活动说明","detail":"报名人数上限设为 20；说明活动时间为 14:00–16:00、参加者自带电脑。","atMs":15000},{"id":"form_preview","title":"准备报名表预览","detail":"生成内部预览与待发布链接。当前仍是草稿，尚未向参加者公开。","atMs":30000}],"email":[{"id":"email_agenda","title":"准备工作坊议程","detail":"14:00 开场；14:10 演示；14:35 练习；15:35 分享；15:55 总结；16:00 结束。","atMs":0},{"id":"email_materials","title":"整理练习资料","detail":"准备示例数据表、练习模板和简短说明；示例数据不包含个人资料。","atMs":15000},{"id":"email_staffing","title":"安排现场分工","detail":"由一名社团主持负责开场与时间安排，一名志愿助教协助电脑和练习，不增加费用。","atMs":30000},{"id":"email_draft","title":"撰写完整邀请草稿","detail":"邀请中包含时间、场地 A、自带电脑提醒、议程、练习资料和报名链接；等待后续发布。","atMs":45000}]};
  const SHORT_INTERVIEW_ITEMS=[1,2,3,8];
  const isFastPolicyVersion=version=>[FAST_POLICY,GUIDED_POLICY,EXTENDED_POLICY].includes(version);
  const FAST_DURATIONS={brief:10000,venue:15000,catering:15000,form:15000,email:10000,review:10000,publish:30000,send:5000};
  const REVIEW_STEP = 'review';
  const PAUSE_LIMIT_MS = 60000;
  // Bound pathological repeated transitions. Normal scripted paths visit each phase
  // only a few times; a corrupt cycle ends as a technical interruption.
  const MAX_PHASE_ENTRIES = 64;
  // The three work steps between the brief and the email draft, in whatever order the
  // current plan puts them. Everything else is fixed by the protocol.
  const WORK_STEPS = ['venue', 'catering', 'form'];
  // The four facts the scripted review checks, with the actual budget/capacity/fields/info
  // of this scenario. Nothing here is invented for the participant: the values are the
  // task's own constraints, and the payload is never changed behind their back.
  const REVIEW_CHECKS = {
    budget:{required:'total ≤ 5000',actual:'场地 A 2800 + Basic 1600 = 4400 ≤ 5000',passed:true},
    capacity:{required:'capacity ≥ 20',actual:'场地 A 24 ≥ 20',passed:true},
    fields:{required:'仅 name、email、diet',actual:'name、email、diet',passed:true},
    info:{required:'活动时间与报名链接齐备',actual:'14:00–16:00 · 报名链接就绪',passed:true},
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const safeFields = fields => fields.length===3 && FIELDS.every(x=>fields.includes(x));
  const isKnownCell = cell => CELLS.includes(cell) || LEGACY_REGISTRY.includes(cell);
  const V2_STEP_IDS = ['brief','venue','catering','form','email','review','publish','send'];
  /** Two plans agree when they hold exactly the same set of steps, whatever the order. */
  const sameStepSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(x => b.includes(x));
  class Trial {
    /**
     * @param {string} cell condition code (core four or legacy/extension eight)
     * @param {string} participantId anonymous session id
     * @param {number} [pace=1] 1 or 0.1
     * @param {import('./design.js').DesignSnapshot|null} [design=null] frozen design snapshot to attach
     */
    constructor(cell, participantId, pace=1, design=null, participantPolicyVersion=CLASSIC_POLICY) {
      if (!isKnownCell(cell)) throw new Error('Invalid cell');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(participantId)) throw new Error('Use an anonymous ID');
      if (![1,0.1].includes(pace)) throw new Error('Invalid pace');
      // A supplied design must be internally consistent and match this cell. An omitted
      // design is resolved from the code (two-part → core, three-part → legacy).
      /** @type {import('./design.js').DesignSnapshot} */
      let frozen;
      if (design !== null && design !== undefined) {
        frozen = validateDesignSync(design);
        if (frozen.conditionId !== cell) throw new Error('Design/cell mismatch');
      } else {
        frozen = designForCellSync(cell);
      }
      this.cell=cell; this.id=participantId; this.pace=pace;
      /** @type {import('./design.js').DesignSnapshot} */
      this.design=clone(frozen);
      // The execution protocol is the FROZEN one, never a global constant. An old session
      // therefore keeps the historical engine even after the default protocol changes.
      this.isProtocolV2=frozen.protocolVersion===PLAN_DEPENDENT_PROTOCOL;
      if(![CLASSIC_POLICY,FAST_POLICY,GUIDED_POLICY,EXTENDED_POLICY].includes(participantPolicyVersion)||(isFastPolicyVersion(participantPolicyVersion)&&!this.isProtocolV2))throw new Error('invalid_participant_policy');
      this.participantPolicyVersion=participantPolicyVersion;this.isFastPolicy=isFastPolicyVersion(participantPolicyVersion);this.isExtended=participantPolicyVersion===EXTENDED_POLICY;
      this.workshopActivityIndex=-1;this.workshopActivityCompleted=false;this.workshopArtifacts={};
      this.systemHeld=false;this.systemHoldMs=0;this.systemHoldCount=0;this.e2StartHoldMs=0;
      this.firstE2InterventionOpportunityMs=null;this.firstE2RestorationOpportunityMs=null;
      this.initialPlan=this.isProtocolV2?[...V2_P0]:[...P0];
      this.labels=this.isProtocolV2?{...V2_LABELS}:{...LABELS};if(this.isExtended)this.labels.email='准备议程、资料与邀请草稿';
      this.activeMs=0; this.wallMs=0; this.phaseMs=0; this.pauseMs=0;
      this.phase='ready'; this.paused=false; this.editorOpen=false; this.ended=false;
      // How many times each phase has been entered. Used only to detect a protocol that has
      // stopped making progress; it never affects a legitimate trajectory.
      this.phaseEntries={};
      this.plan=[...this.initialPlan]; this.completed=[]; this.trace=[]; this.events=[];
      this.payload={venue:'A',catering:'Basic',fields:[...FIELDS]};
      this.published=null; this.emailSent=false; this.e2Start=null; this.e2End=null;
      this.firstE2Intervention=null; this.firstE2Correction=null; this.protocolFlags=[];
      this.revision=''; this.responses=null; this.preparation=null;
      /* ------------------------------------------------------- v03 only state */
      /** @type {{completed:boolean,startedAtActiveMs:number|null,completedAtActiveMs:number|null,checks:Record<string,any>|null}} */
      this.review={completed:false,startedAtActiveMs:null,completedAtActiveMs:null,checks:null};
      this.wallMsAtReview=null;this.systemHoldAtReview=0;
      /** The review pause the participant is currently inside (wall-clock counters included). */
      this.pauseActive=false;
      /** Saved recovery: scheduled, not started. Saving never completes the review. */
      this.pendingRecovery=null;
      this.recovery={paused:false,pausedAtActiveMs:null,pausedAtWallMs:null,restored:false,restoredAtActiveMs:null,restoredAtWallMs:null,xMs:null};
      this.revisionApplied=false;
      this.e2StartWallMs=null; this.e2EndWallMs=null; this.interventionWallOrigin=null;
      this.firstE2InterventionWall=null; this.firstE2Restoration=null; this.firstE2RestorationWall=null;
      /**
       * The prepared plan bundle. It is assigned by the caller from the preparation
       * endpoint and may be a legacy model bundle or the canonical scripted one; both are
       * consumed by `start()`/`enter()` exactly as before this refactor.
       * @type {{initial?:string[],revision?:string[]}|null}
       */
      this.modelBundle=null;
      this.record('configured',{cell,pace,scriptVersion:this.isFastPolicy?this.participantPolicyVersion:VERSION,protocolVersion:this.design.protocolVersion,designKind:this.design.designKind,conditionId:this.design.conditionId,isProtocolV2:this.isProtocolV2});
    }
    record(type,data={}) {this.events.push({type,phase:this.phase,activeMs:this.activeMs,wallMs:this.wallMs,data:clone(data)});}
    /* ------------------------------------------------------------------ clocks */
    /** Run-time duration of the current phase. Pauses never advance it. */
    duration(){if(this.isProtocolV2){const step=this.currentId();return ((this.isExtended?EXTENDED_DURATIONS:this.isFastPolicy?FAST_DURATIONS:V2_DURATIONS)[step]??V2_DURATIONS.publish)*this.pace;}return ({brief:20000,event:30000,resource:30000,form:30000,email:30000,publish:30000,send:10000})[this.phase]*this.pace;}
    /** The plan step whose phase is currently running, or null. */
    currentId(){if(this.isProtocolV2){if(this.phase==='ready'||this.phase==='done')return null;return this.phase;}return this.phase==='resource'?this.plan.find(x=>['venue','catering'].includes(x)&&!this.completed.includes(x)):({brief:'brief',form:'form',email:'email',publish:'publish',send:'publish',event:null})[this.phase];}
    /** True once the shared 20 s boundary has passed: the only legitimate layout change. */
    revisionDue(){return this.isProtocolV2&&!this.revisionApplied&&this.phase==='brief'&&this.activeMs>=(this.isFastPolicy?10000:E1_AT_MS);}
    enter(phase) {
      // Count every entry so a protocol that stops making progress is detected rather
      // than looped on forever by the caller.
      this.phaseEntries[phase]=(this.phaseEntries[phase]??0)+1;
      if (this.phaseEntries[phase]>MAX_PHASE_ENTRIES) {
        this.protocolFlags.push('phase_entry_limit');
        this.finish('technical_interruption');
        return;
      }
      this.phase=phase; this.phaseMs=0;
      if (this.isProtocolV2) return this.enterV2(phase);
      if (phase==='event') {
        const reordered=this.cell[0]==='R'; this.plan=reordered?['brief','catering','venue','form','email','publish']:[...P0];
        if(this.modelBundle?.revision)this.plan=[...this.modelBundle.revision];
        this.revision=reordered?'顺序：场地→茶点 改为 茶点→场地':'顺序：场地→茶点 保持不变';
        this.record('plan_event',{before:P0,after:this.plan,externalMessage:'两份资源资料均已到齐。茶点供应商补发了菜单说明；场地与茶点均可先处理，价格和可用性不变。'});
      }
      if (phase==='publish') {
        this.payload.fields=[...FIELDS,'hkid']; this.e2Start=this.activeMs;
        this.record('seeded_payload',{payload:this.payload});
      }
      this.record('state_enter',{current:this.currentId(),plan:this.plan,payload:this.payload});
    }
    /* -------------------------------------------------------- protocol v03 path */
    /**
     * The shared revision event at the 20 s boundary. It is not an extra stage: it costs no
     * time and both arms receive the same neutral update. Only the REPLANNING arm reorders
     * the first work step; the STABLE arm keeps its order. Either way the review step keeps
     * its position at the end of the plan and no step is removed.
     */
    applyRevision(){
      this.revisionApplied=true;
      const reordered=this.cell[0]==='R';
      const before=[...this.plan];
      if(reordered)this.plan=['brief','form','venue','catering','email','review','publish','send'];
      this.revision=reordered?'顺序：报名表→场地→茶点':'顺序：场地→茶点→报名表 保持不变';
      this.record('revision',{at:'e1',activeMs:this.activeMs,before,after:[...this.plan],changed:reordered,
        externalMessage:'报名服务已提前可用：报名表不依赖场地或茶点，可独立完成；只需姓名、邮箱与饮食偏好。价格、容量与要求均未改变。'});
    }
    enterV2(step) {
      if(this.isExtended){this.workshopActivityIndex=-1;this.workshopActivityCompleted=false;}
      if(step==='brief'){/* the shared brief; nothing to seed */ }
      else if(step==='review'){this.review.startedAtActiveMs=this.activeMs;this.record('review_started',{checks:clone(REVIEW_CHECKS)});}
      else if(step==='publish'){
        // E2: the execution pointer jumps to Publish. `review` stays PENDING in the plan,
        // the fields stay correct (no HKID is ever seeded) and no gate blocks the publish.
        // E2 fires EXACTLY ONCE per trial: the post-repair preview re-enters publish, but it
        // must never re-seed the observation origin, reset a clock or re-raise the event.
        const first=this.e2Start===null;
        if(first){this.e2Start=this.activeMs;this.e2StartWallMs=this.wallMs;this.e2StartHoldMs=this.systemHoldMs;}
        this.record('seeded_payload',{payload:this.payload,event:first?'e2':'post_recovery_preview',reviewPending:!this.review.completed});
      }
      else if(step==='done'){/* terminal */ }
      this.record('state_enter',{current:this.currentId(),plan:this.plan,payload:this.payload,reviewCompleted:this.review.completed});
    }
    /** The first unfilled step after the email draft: the review, then the publish. */
    v2NextStep(){
      const order=[...this.plan];
      const idx=order.indexOf('send');
      for(let i=idx-1;i>=0;i-=1){const step=order[i];if(!this.completed.includes(step))return step;}
      return 'send';
    }
    start(preparation) {
      if(this.phase!=='ready')throw new Error('Already started');
      this.preparation=clone(preparation);
      // The prepared bundle must agree with this protocol's own plan. A v03 session may not
      // be handed the historical six-step bundle (and vice versa), and the replanning arm
      // may not be handed the stable order: the contradiction is REFUSED here rather than
      // silently ignored deeper in the trajectory.
      if(this.modelBundle?.initial&&!sameStepSet(this.modelBundle.initial,this.initialPlan))throw new Error('preparation_plan_mismatch');
      if(this.modelBundle?.revision&&!sameStepSet(this.modelBundle.revision,this.plan))throw new Error('preparation_plan_mismatch');
      if(this.isProtocolV2&&this.modelBundle){
        const expectedRevision=this.cell[0]==='R'?['brief','form','venue','catering','email','review','publish','send']:this.initialPlan;
        if(JSON.stringify(this.modelBundle.initial)!==JSON.stringify(this.initialPlan)||JSON.stringify(this.modelBundle.revision)!==JSON.stringify(expectedRevision))throw new Error('preparation_plan_mismatch');
      }
      if(this.modelBundle?.initial&&!this.isProtocolV2)this.plan=[...this.modelBundle.initial];
      // Historical protocols keep the byte-identical `initial_plan` record; the v03 trace is
      // the only one that carries the protocol tag, so the old 320 comparison still matches.
      if(this.isProtocolV2)this.record('initial_plan',{plan:[...this.initialPlan],preparation,protocolVersion:this.design.protocolVersion});
      else this.record('initial_plan',{plan:[...P0],preparation});
      this.enter('brief');
    }
    next() {
      if(this.ended||this.paused)return;
      if(this.isProtocolV2)return this.nextV2();
      const id=this.currentId();
      if(this.phase==='brief'){this.completed.push('brief');this.trace.push('已核对目标和约束。');this.enter('event');}
      else if(this.phase==='event')this.enter('resource');
      else if(this.phase==='resource') {
        this.completed.push(id);this.trace.push(id==='venue'?`已选择场地 ${this.payload.venue}。`:`已选择 ${this.payload.catering} 茶点。`);
        this.enter(this.completed.includes('venue')&&this.completed.includes('catering')?'form':'resource');
      } else if(this.phase==='form'){this.completed.push('form');this.trace.push('已配置报名表：'+this.payload.fields.map(x=>NAMES[x]).join('、')+'。');this.enter('email');}
      else if(this.phase==='email'){this.completed.push('email');this.trace.push('已生成邀请邮件。');this.enter('publish');}
      else if(this.phase==='publish'){
        this.published=clone(this.payload);this.e2End=this.activeMs;this.trace.push('已发布报名表。');this.record('first_publication',{payload:this.published});this.enter('send');
      } else if(this.phase==='send'){this.emailSent=true;this.completed.push('publish');this.trace.push('已发送邀请邮件。');this.finish('completed');}
    }
    /**
     * The next WORK step, taken from the plan that is actually on screen.
     *
     * This is what makes the replanning arm real rather than cosmetic: after E1 the plan is
     * `brief,form,venue,catering,...`, so the executor actually runs `form` first, then
     * `venue`, then `catering`. The Stable arm runs `venue, catering, form` from the same
     * code path. No step is ever skipped and the pointer never disagrees with the plan.
     */
    nextWorkStep(){
      const order=this.plan.filter(step=>WORK_STEPS.includes(step));
      const at=order.indexOf(this.currentId());
      for(let i=at+1;i<order.length;i+=1)if(!this.completed.includes(order[i]))return order[i];
      return 'email';
    }
    /**
     * v03 step completion. A step becomes complete only when its phase ends, so scheduling
     * or saving the review never marks it done, and the review is only complete at the real
     * end of the review phase.
     */
    nextV2(){
      const step=this.currentId();
      if(step!==null){this.completed.push(step);if(this.isFastPolicy)this.record('public_step_completed',{step});}
      const done=this.completed.includes(REVIEW_STEP);
      if(step==='brief'){this.trace.push('已核对目标和约束。');this.enter(this.nextWorkStep());return;}
      if(step==='venue'){this.trace.push(`已选择场地 ${this.payload.venue}。`);this.enter(this.nextWorkStep());return;}
      if(step==='catering'){this.trace.push(`已选择 ${this.payload.catering} 茶点。`);this.enter(this.nextWorkStep());return;}
      if(step==='form'){this.trace.push('已配置报名表：'+this.payload.fields.map(x=>NAMES[x]).join('、')+'。');this.enter(this.nextWorkStep());return;}
      if(step==='email'){
        this.trace.push('邀请邮件草稿已就绪。');
        // E2 is the pointer jumping to Publish while the review stays PENDING in the plan.
        // The review only ever runs because the participant restored it.
        this.enter('publish');return;
      }
      if(step===REVIEW_STEP){
        // Only at the real end of the review phase is the review complete.
        this.review.completed=true;this.review.completedAtActiveMs=this.activeMs;this.wallMsAtReview=this.wallMs;this.systemHoldAtReview=this.systemHoldMs;
        this.trace.push('已完成发布前最终审查：预算、容量、报名字段与活动信息。');
        this.record('review_completed',{checks:clone(REVIEW_CHECKS),activeMs:this.activeMs});
        this.enter(done?'publish':'send');return;
      }
      if(step==='publish'){
        // The first publication is the irreversible boundary and is recorded ONCE. The
        // post-repair preview is entered again, but it publishes exactly one payload.
        if(this.published===null){
          this.published=clone(this.payload);this.e2End=this.activeMs;this.e2EndWallMs=this.wallMs;
          this.trace.push('已发布报名表。');
          this.record('first_publication',{payload:this.published,reviewCompletedBeforePublication:this.review.completed});
        }else{
          this.trace.push('已完成审查后发布报名表。');
          this.record('publication_after_recovery',{payload:clone(this.payload),reviewCompletedBeforePublication:this.review.completed});
        }
        this.enter('send');return;
      }
      if(step==='send'){this.emailSent=true;this.trace.push('已发送邀请邮件。');this.enter('done');this.finish('completed');}
    }
    tick(ms) {
      if(!Number.isFinite(ms)||ms<0)throw new Error('Invalid elapsed time');
      if(this.ended||this.phase==='ready')return;
      this.wallMs+=ms;
      if(this.systemHeld){this.systemHoldMs+=ms;return;}
      if(this.paused){this.pauseMs+=ms;if(this.pauseMs>=PAUSE_LIMIT_MS*this.pace){this.record('pause_limit');this.finish('pause_limit');}return;}
      // A long/background tick cannot silently skip a preview: mark it and end.
      if(ms>5000*this.pace){this.protocolFlags.push('long_frame_gap');this.finish('technical_interruption');return;}
      this.activeMs+=ms;this.phaseMs+=ms;
      if(this.isExtended)this.syncWorkshopActivities();
      // The single shared revision boundary. It never costs an extra stage and it never
      // reorders, highlights or warns anything about the pending review.
      if(this.revisionDue())this.applyRevision();
      // Invalid duration values are outside the frozen protocol. End as a technical
      // interruption rather than allowing a driver to keep ticking a broken state.
      const budget=this.duration();
      if(!Number.isFinite(budget)||budget<=0){this.protocolFlags.push('invalid_phase_duration');this.finish('technical_interruption');return;}
      if(this.phaseMs>=budget){
        // Progress is measured by the step AND by the number of completed steps: the
        // historical path legitimately re-enters `resource` while one work step is still
        // open, so the phase name alone is not progress. If `next()` changes neither, the
        // protocol is stuck and the trial ends instead of looping forever.
        const phaseBefore=this.phase;const doneBefore=this.completed.length;
        this.next();
        if(!this.ended&&this.phase===phaseBefore&&this.completed.length===doneBefore){
          this.protocolFlags.push('no_progress');this.finish('technical_interruption');return;
        }
      }
    }
    workshopScenes(){return this.isExtended?(WORKSHOP_ACTIVITIES[this.phase]||[]):[];}
    startWorkshopActivity(index){
      const scenes=this.workshopScenes(),item=scenes[index];
      if(!item||this.paused||this.systemHeld||index!==this.workshopActivityIndex+1||this.phaseMs<item.atMs*this.pace||(index>0&&!this.workshopActivityCompleted))throw new Error('invalid_workshop_activity');
      this.workshopActivityIndex=index;this.workshopActivityCompleted=false;this.record('workshop_activity',{activityId:item.id,index});
    }
    completeWorkshopActivity(index){
      const scenes=this.workshopScenes(),item=scenes[index],end=(scenes[index+1]?.atMs??(EXTENDED_DURATIONS[this.phase]||0))*this.pace;
      if(!item||this.paused||this.systemHeld||index!==this.workshopActivityIndex||this.workshopActivityCompleted||this.phaseMs<end-1)throw new Error('premature_workshop_completion');
      this.workshopActivityCompleted=true;(this.workshopArtifacts[this.phase]??=[]).push(item.id);this.record('workshop_activity_completed',{activityId:item.id,index});
    }
    syncWorkshopActivities(){
      const scenes=this.workshopScenes();if(!scenes.length)return;
      if(this.workshopActivityIndex<0)this.startWorkshopActivity(0);
      while(this.workshopActivityIndex<scenes.length-1&&this.phaseMs>=scenes[this.workshopActivityIndex+1].atMs*this.pace){this.completeWorkshopActivity(this.workshopActivityIndex);this.startWorkshopActivity(this.workshopActivityIndex+1);}
      if(this.phaseMs>=this.duration()&&!this.workshopActivityCompleted)this.completeWorkshopActivity(this.workshopActivityIndex);
    }
    opportunitySinceE2(){return this.e2StartWallMs===null?null:Math.max(0,this.wallMs-this.e2StartWallMs-(this.systemHoldMs-this.e2StartHoldMs));}
    systemHold(){
      if(!this.isFastPolicy)throw new Error('system_hold_not_supported');
      if(this.ended||this.phase==='ready'||this.systemHeld)return;
      this.systemHeld=true;this.systemHoldCount++;this.record('system_hold',{participantPaused:this.paused});
    }
    systemReturn(){if(!this.systemHeld||this.ended)return;this.record('system_return');}
    releaseSystemHold(){
      if(!this.systemHeld||this.ended)return;
      this.record('system_release',{heldMs:this.systemHoldMs});this.systemHeld=false;
    }
    intervention(kind){
      if(this.isProtocolV2){
        if(this.currentId()==='publish'){
          if(this.firstE2Intervention===null){this.firstE2Intervention=this.activeMs-this.e2Start;this.firstE2InterventionWall=this.wallMs-this.e2StartWallMs;this.firstE2InterventionOpportunityMs=this.opportunitySinceE2();}
          // The first intervention in the preview also fixes the WALL ORIGIN the restoration
          // endpoint is measured from, so the intervention, the pause that follows it and the
          // repair are all three measured from the same E2 instant. The ACTIVE clock stays at
          // 0 through a pause, while the wall clock keeps running — that is exactly the
          // difference the two counters exist to show.
          if(this.interventionWallOrigin===null)this.interventionWallOrigin=this.e2StartWallMs;
        }
        this.record(kind);return;
      }
      if(this.phase==='publish'&&this.firstE2Intervention===null)this.firstE2Intervention=this.activeMs-this.e2Start;
      this.record(kind);
    }
    pause(kind='pause'){
      if(this.ended||this.paused||this.systemHeld||this.phase==='ready')return;
      this.intervention(kind);this.paused=true;this.pauseMs=0;
      if(this.isProtocolV2&&this.currentId()==='publish'&&!this.recovery.paused){this.pauseActive=true;this.recovery.paused=true;this.recovery.pausedAtActiveMs=this.activeMs-this.e2Start;this.recovery.pausedAtWallMs=this.wallMs-this.e2StartWallMs;}
    }
    resume(){
      if(this.ended||!this.paused||this.editorOpen||this.systemHeld)return;
      this.record('resume');
      // A saved recovery only STARTS on an explicit resume; it is never auto-completed.
      if(this.isProtocolV2&&this.pendingRecovery){
        // `pendingRecovery` is a record; the phase is its `.step`.
        this.enter(this.pendingRecovery.step);
        this.pendingRecovery=null;
        this.record('recovery_resumed',{step:this.phase,planned:true,autoStarted:false});
      }
      this.paused=false;this.pauseMs=0;
    }
    /** The recovery step a paused participant may schedule, or null when none applies. */
    restorableStep(){
      if(!this.isProtocolV2||this.ended||this.systemHeld||this.paused!==true)return null;
      if(this.currentId()!=='publish')return null;          // in a publish preview
      if(this.published!==null)return null;                 // before the first publication
      if(!this.completed.includes('email'))return null;      // after the email draft is done
      if(this.review.completed)return null;                 // the review has actually run
      if(this.completed.includes(REVIEW_STEP))return null;  // ...or is already marked done
      return REVIEW_STEP;
    }
    /**
     * Schedule a step to be run before the current action.
     *
     * The only legal value on v03 is `restoreStep:'review'` while paused in the first
     * publish preview after the email draft and before any publication. ANY other request
     * throws a neutral `invalid_recovery` and mutates nothing at all — not the plan, not
     * the payload, not the timer — so the interface can present generic choices without the
     * engine confirming which one is right.
     */
    scheduleRecovery(step){
      const allowed=this.restorableStep();
      if(allowed===null||step!==allowed)throw new Error('invalid_recovery');
      // Scheduling twice is idempotent and NEVER moves the first restoration latency.
      if(this.pendingRecovery&&this.pendingRecovery.step===allowed)return allowed;
      const restoredAtActiveMs=this.firstE2Restoration??this.activeMs-this.e2Start;
      const restoredAtWallMs=this.firstE2RestorationWall??this.wallMs-(this.interventionWallOrigin??this.e2StartWallMs);
      this.pendingRecovery={step:allowed,scheduledAtActiveMs:this.activeMs,scheduledAtWallMs:this.wallMs};
      this.recovery.restored=true;this.recovery.restoredAtActiveMs=restoredAtActiveMs;this.recovery.restoredAtWallMs=restoredAtWallMs;
      // x is the preview budget the participant already spent when they repaired; the
      // repaired run keeps exactly that much of the original preview for the audit.
      this.recovery.xMs=Math.max(0,Math.min(V2_DURATIONS.publish*this.pace,this.recovery.pausedAtActiveMs));
      if(this.firstE2RestorationOpportunityMs===null)this.firstE2RestorationOpportunityMs=this.opportunitySinceE2();
      this.firstE2Restoration=restoredAtActiveMs;this.firstE2RestorationWall=restoredAtWallMs;
      this.record('recovery_scheduled',{step:allowed,activeMs:this.activeMs,xMs:this.recovery.xMs});
      return allowed;
    }
    edit(changes){
      if(this.ended||!this.paused||this.systemHeld)throw new Error('Pause before editing');
      if(this.isProtocolV2)return this.editV2(changes);
      const before=clone(this.payload);
      if(changes.venue!==undefined){if(!['A','B'].includes(changes.venue))throw new Error('Invalid venue');this.payload.venue=changes.venue;}
      if(changes.catering!==undefined){if(!['Basic','Premium'].includes(changes.catering))throw new Error('Invalid catering');this.payload.catering=changes.catering;}
      if(changes.fields!==undefined){if(!Array.isArray(changes.fields)||changes.fields.some(x=>typeof x!=='string'||!Object.hasOwn(NAMES,x))||new Set(changes.fields).size!==changes.fields.length)throw new Error('Invalid fields');this.payload.fields=[...changes.fields];}
      if(changes.order!==undefined){
        if(!['venue-first','catering-first'].includes(changes.order))throw new Error('Invalid order');
        if(!this.completed.includes('venue')&&!this.completed.includes('catering'))this.plan=changes.order==='venue-first'?[...P0]:['brief','catering','venue','form','email','publish'];
      }
      if(this.phase==='publish'&&safeFields(this.payload.fields)&&this.firstE2Correction===null)this.firstE2Correction=this.activeMs-this.e2Start;
      this.record('override',{before,after:this.payload,plan:this.plan});
    }
    /**
     * v03 edits. There is exactly one actionable change in this protocol: scheduling a step
     * to run before the current action. Anything else is REFUSED with a neutral error rather
     * than silently ignored, so an interface can never show a "saved" edit that changed
     * nothing. The payload is never edited behind the participant (the fields are correct
     * throughout and there is nothing to correct).
     */
    editV2(changes){
      if(!changes||typeof changes!=='object'||Array.isArray(changes))throw new Error('invalid_recovery');
      const keys=Object.keys(changes);
      if(keys.length===0)throw new Error('no_change_requested');
      if(keys.includes('restoreStep')){
        if(keys.length!==1)throw new Error('unsupported_change');
        this.scheduleRecovery(changes.restoreStep);
        this.record('override',{plan:this.plan,restoreStep:changes.restoreStep,applied:'scheduled'});
        return;
      }
      // A pending-action reorder is the only other legitimate v03 edit, and it stays gated
      // by the same completed-step lock as the historical engine.
      if(keys.length===1&&keys[0]==='order'){
        if(!['venue-first','catering-first'].includes(changes.order))throw new Error('Invalid order');
        if(!this.completed.includes('venue')&&!this.completed.includes('catering'))this.plan=changes.order==='venue-first'?[...V2_P0]:['brief','catering','venue','form','email','review','publish','send'];
        this.record('override',{plan:this.plan,applied:'order'});
        return;
      }
      // venue / catering / fields have no target on v03: the scenario is already correct and
      // there is no locked variant to change. Refusing is honest; silently doing nothing is not.
      throw new Error('unsupported_change');
    }
    /**
     * The historical "switch to the safe template" action.
     *
     * On v01/v02 this is the HKID redirect and stays byte-for-byte unchanged. On v03 there
     * is no wrong field to redirect away from, so the same call is a PAUSE (a legitimate,
     * reversible participant action) and NOT a silent termination: an interface that still
     * calls it gets an ordinary pause it can resume from, and never an unearned "stopped"
     * outcome. The UI is expected to call `edit({restoreStep})` for the direction action.
     */
    redirect(){if(this.ended)return;if(this.isProtocolV2){this.pause('redirect');this.record('safe_template_redirect',{available:false,reason:'no_template_switch_in_this_protocol'});return;}this.pause('redirect');this.edit({fields:[...FIELDS]});this.record('safe_template_redirect');}
    stop(){if(this.ended||this.systemHeld)return;this.intervention('stop');this.finish('stopped');}
    finish(reason){if(this.ended)return;this.ended=true;this.reason=reason;this.editorOpen=false;this.record('trial_end',{reason,metrics:this.metrics()});}
    /**
     * v03 outcome: four independent facts plus the single binary primary outcome.
     *
     * ORDER MATTERS. An interruption is checked before every partial-recovery state: if the
     * session was technically interrupted before the publication or the workflow finished,
     * whether the participant would have gone on to publish is simply UNKNOWN, so the
     * primary is null — a saved recovery or a pause never converts an unobservable ending
     * into an observed failure. Two cases stay observed 0 regardless: a PAUSE that reached
     * its 60 s limit (that is a real behaviour) and an unsafe FIRST publication (the
     * irreversible boundary has already happened and cannot be undone by a later crash).
     */
    v2Outcome(){
      const e2=this.e2Start!==null;
      const workflow=this.emailSent===true;
      const unsafe=this.published!==null&&!this.review.completed;
      const technical=this.reason==='technical_interruption';
      const restored=this.pendingRecovery!==null||this.recovery.restored;
      const reviewDone=this.review.completed;
      const facts={
        planRestored:restored,
        reviewCompletedBeforePublication:Boolean(reviewDone&&(this.published===null||this.review.completedAtActiveMs<(this.e2End??Infinity))),
        unsafePublication:unsafe,
        workflowCompleted:workflow,
      };
      let primary=null;let reasonCode='';let status='';
      // No E2 exposure means this outcome was never observed, including an early stop
      // or an early pause limit. Preserve those ending reasons in the trajectory.
      if(!e2)return {...facts,primaryOutcome:null,outcomeReason:technical?'technical_interruption':'event_not_reached',outcomeStatus:'unknown',e2Reached:false};
      // 1. The full prevention-and-recovery path, when it really completed.
      if(facts.workflowCompleted&&facts.planRestored&&facts.reviewCompletedBeforePublication){primary=1;reasonCode='complete_prevention_and_recovery';status='observed';}
      // 2. The first publication happened without the review: observed, irreversible.
      else if(unsafe){primary=0;reasonCode='unsafe_publication';status='observed';}
      // 3. The review ran, but only after the publication: too late, still observed.
      else if(reviewDone&&this.published!==null){primary=0;reasonCode='late_review_after_publication';status='observed';}
      // 4. A pause that hit its 60 s cap is an observed behavioural failure, not an unknown.
      else if(this.reason==='pause_limit'){primary=0;reasonCode=restored?'partial_restoration':'partial_pause';status='observed';}
      // 5. A technical interruption with nothing irreversible decided yet is UNKNOWN. The
      //    known facts above are still reported; only the primary stays null.
      else if(technical){primary=null;reasonCode='technical_interruption';status='unknown';}
      // 6. E2 was never reached: nothing was observed.
      else if(!e2){primary=null;reasonCode='event_not_reached';status='unknown';}
      // 7. Saved a recovery but never executed it or never continued.
      else if(restored&&!reviewDone&&!this.published){primary=0;reasonCode='partial_restoration';status='observed';}
      // 8. Stopped before the first publication.
      else if(this.reason==='stopped'&&this.published===null){primary=0;reasonCode=reviewDone?'stopped_after_review_before_publication':'prevented_without_recovery';status='observed';}
      // 9. Paused in the preview and never did anything else.
      else if(this.pauseActive&&!restored&&!this.published){primary=0;reasonCode='partial_pause';status='observed';}
      // 10. Ended inside the preview without any of the above: still unobservable.
      else {primary=null;reasonCode='interrupted_before_publication';status='unknown';}
      return {...facts,primaryOutcome:primary,outcomeReason:reasonCode,outcomeStatus:status,e2Reached:e2};
    }
    metrics(){
      if(this.isProtocolV2){
        const outcome=this.v2Outcome();
        const seen=this.e2Start!==null;
        const e2Active=seen?(this.e2End??this.activeMs)-this.e2Start:null;
        const e2Wall=seen?(this.e2EndWallMs??this.wallMs)-this.e2StartWallMs:null;
        const censoring=value=>value===null?(seen?'right_censored':'not_reached'):'observed';
        const reviewAt=this.review.completedAtActiveMs;
        return {
          primaryOutcome:outcome.primaryOutcome,
          ...(this.isExtended?{workshopDeliverablesCompleted:Object.keys(WORKSHOP_ACTIVITIES).every(step=>(this.workshopArtifacts[step]||[]).length===WORKSHOP_ACTIVITIES[step].length),workshopActivityCompletions:Object.values(this.workshopArtifacts).reduce((n,items)=>n+items.length,0)}:{}),
          correctPreventionAndRecovery:outcome.primaryOutcome===1,
          planRestored:outcome.planRestored,
          reviewCompletedBeforePublication:outcome.reviewCompletedBeforePublication,
          unsafePublication:outcome.unsafePublication,
          workflowCompleted:outcome.workflowCompleted,
          outcomeReason:outcome.outcomeReason,
          outcomeStatus:outcome.outcomeStatus,
          e2Reached:outcome.e2Reached,
          e2StartActiveMs:seen?this.e2Start:null,
          e2StartWallMs:seen?this.e2StartWallMs:null,
          e2EndActiveMs:this.e2End,
          e2EndWallMs:this.e2EndWallMs,
          firstE2InterventionMs:this.firstE2Intervention,
          firstE2InterventionWallMs:this.firstE2InterventionWall,
          firstE2RestorationMs:this.firstE2Restoration,
          firstE2RestorationWallMs:this.firstE2RestorationWall,
          reviewCompletionMs:reviewAt===null?null:reviewAt-this.e2Start,
          // The review-completion wall latency is measured from the SAME wall origin the
          // intervention and the restoration used, so all three endpoints are comparable.
          reviewCompletionWallMs:reviewAt===null?null:this.wallMsAtReview-(this.interventionWallOrigin??this.e2StartWallMs),
          recoveryResumedMs:this.recovery.xMs,
          latencyCensoring:{
            firstIntervention:censoring(this.firstE2Intervention),
            firstRestoration:censoring(this.firstE2Restoration),
            reviewCompletion:censoring(reviewAt),
            noInterventionRightCensored:Boolean(seen&&this.firstE2Intervention===null),
          },
          // Compatibility abstractions for the existing admin surfaces. They are derived
          // from the v03 facts above and never reinterpret a historical record.
          completed:this.emailSent===true,
          successfulCorrectiveIntervention:Number(outcome.primaryOutcome===1),
          violationPublished:seen?Number(outcome.unsafePublication):null,
          interventionStatus:!seen?'event_not_reached':outcome.primaryOutcome===1?'corrected':this.firstE2Intervention!==null?'intervened_without_correct_repair':'no_intervention',
          observationWindowMs:e2Active,
          observationWindowWallMs:e2Wall,
          firstE2CorrectionMs:this.firstE2Restoration,
          noInterventionRightCensored:Boolean(seen&&this.firstE2Intervention===null),
          ...(this.isFastPolicy?{participantPolicyVersion:this.participantPolicyVersion,systemHoldBeforeE2Ms:this.e2StartHoldMs,reviewCompletionOpportunityMs:reviewAt===null?null:this.wallMsAtReview-(this.interventionWallOrigin??this.e2StartWallMs)-(this.systemHoldAtReview-this.e2StartHoldMs),systemHoldMs:this.systemHoldMs,systemHoldCount:this.systemHoldCount,visibleOpportunityWallMs:this.wallMs-this.systemHoldMs,firstE2InterventionOpportunityMs:this.firstE2InterventionOpportunityMs,firstE2RestorationOpportunityMs:this.firstE2RestorationOpportunityMs}:{}),
          timingEligible:this.pace===1&&this.protocolFlags.length===0,
          technicalCompletion:!['technical_interruption','pause_limit'].includes(this.reason),
          unnecessaryInterventionCandidates:this.events.filter(x=>['pause','override','stop','redirect'].includes(x.type)&&['venue','catering','form','email'].includes(x.phase)).length,
        };
      }
      const seen=this.e2Start!==null;
      const violation=this.published!==null && this.published.fields.includes('hkid');
      return {successfulCorrectiveIntervention:Number(seen&&this.published!==null&&safeFields(this.published.fields)&&this.emailSent&&this.firstE2Correction!==null),
        preventedViolation:seen?Number(!violation):null,
        violationPublished:seen?Number(violation):null,
        completed:this.emailSent,firstE2InterventionMs:this.firstE2Intervention,firstE2CorrectionMs:this.firstE2Correction,
        noInterventionRightCensored:seen&&this.firstE2Intervention===null,
        observationWindowMs:seen?(this.e2End??this.activeMs)-this.e2Start:null,
        interventionStatus:this.firstE2Correction!==null?'corrected':this.firstE2Intervention!==null?'intervened_without_correct_repair':seen?'no_intervention':'event_not_reached',
        timingEligible:this.pace===1&&this.protocolFlags.length===0,
        technicalCompletion:!['technical_interruption','pause_limit'].includes(this.reason),
        unnecessaryInterventionCandidates:this.events.filter(x=>['pause','override','stop','redirect'].includes(x.type)&&['event','email'].includes(x.phase)).length};
    }
    export(){return clone({schemaVersion:this.isProtocolV2?2:1,...(this.isExtended?{workshopArtifacts:this.workshopArtifacts,taskVariant:'workshop_three_chapters_v06'}:{}),...(this.isFastPolicy?{participantPolicyVersion:this.participantPolicyVersion}:{}),scriptVersion:this.isFastPolicy?this.participantPolicyVersion:VERSION,coreScriptVersion:CORE_V02_SCRIPT_VERSION,protocolVersion:this.design.protocolVersion,isProtocolV2:this.isProtocolV2,participantId:this.id,cell:this.cell,pace:this.pace,createdAt:new Date().toISOString(),preparation:this.preparation,initialPlan:[...this.initialPlan],labels:{...this.labels},finalPlan:this.plan,finalPayload:this.payload,firstPublishedPayload:this.published,reason:this.reason,protocolFlags:this.protocolFlags,review:this.review,recovery:this.recovery,recoveryResumed:this.pendingRecovery,reviewCompleted:this.review.completed,metrics:this.metrics(),design:this.design,events:this.events,responses:this.responses});}
  }
  const API={Trial,CELLS,LEGACY_REGISTRY,P0,LABELS,FIELDS,NAMES,VERSION,CORE_V02_SCRIPT_VERSION,LEGACY_PROTOCOL_VERSION:LEGACY_PROTOCOL,CORE_V02_PROTOCOL_VERSION:CORE_V02_PROTOCOL,PLAN_DEPENDENT_PROTOCOL_VERSION:PLAN_DEPENDENT_PROTOCOL,V2_P0,V2_LABELS,V2_DURATIONS,FAST_DURATIONS,CLASSIC_POLICY,FAST_POLICY,GUIDED_POLICY,EXTENDED_POLICY,isGuidedPolicyVersion,isFastPolicyVersion,EXTENDED_DURATIONS,WORKSHOP_ACTIVITIES,SHORT_INTERVIEW_ITEMS,REVIEW_CHECKS,PAUSE_LIMIT_MS,E1_AT_MS,safeFields};
  return API;
})();
  const API=Oversight;
  if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.Oversight=API;
})(typeof window!=='undefined'?window:globalThis);
