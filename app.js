'use strict';
// The condition registry is NOT read from the engine here: StudyDesign owns it. The
// engine is used only for the deterministic scripted trajectory.
//
// PROTOCOL VERSIONING (per-instance, never a global constant).
//
// The engine exposes THREE protocol generations side by side, so this file never guesses
// from a cell code and never reads a global step list for anything a participant sees:
//   * 2026-10-19-plan-dependent-v03 — the current default. Eight step ids, an ordinary
//     pending "review" row, and a recoverable review-recovery event.
//   * 2026-10-19-core-v02 — the frozen 2×2 with the six legacy ids and the HKID field.
//   * 2026-10-11-online-v01 — the legacy 2×2×2, model-backed.
// `trial.isProtocolV2`, `trial.initialPlan` and `trial.labels` are the ONLY authority for
// this session's plan; the module-level `P0`/`LABELS` below exist solely as the pre-v03
// fallback so an old snapshot keeps rendering exactly as it did before this change.
const {Trial,P0,LABELS,FIELDS,NAMES}=Oversight;
const StudyDesign=window.StudyDesign;
const UI_VERSION='2026-10-30-workshop-extended-v08';
// Behavioural telemetry. Fire and forget everywhere: it never runs inside the timed
// execution path and never blocks completion. Event ids are stable for idempotent retry.
const telemetry=HLLTelemetry.create();
const app=document.querySelector('#app'),phaseLabel=document.querySelector('#phase-label');
let trial=null,stage='setup',timer=null,lastTick=0,prepStarted=0,preparation={},surveyAnswers={},surveyPage=0,lastPlanShown=null;
// ------------------------------------------------- per-instance protocol access
// Every helper below reads the TRIAL, never a module-level constant, so an old snapshot
// keeps its six legacy ids and its own labels while the current protocol uses the eight
// v03 ids. `isProtocolV2` is the engine's own boolean; the label/plan fallbacks only
// matter for an engine build that predates it, in which case the old behaviour applies.
const v2=()=>Boolean(trial&&trial.isProtocolV2);
const fast=()=>Boolean(trial&&trial.isFastPolicy);
let coreSurveyLock=null,taskRecordLock=null,lastWorkshopView=null;
const guided=()=>Oversight.isGuidedPolicyVersion(participantPolicy());
const extended=()=>participantPolicy()===Oversight.EXTENDED_POLICY;
const activityById=id=>Object.values(Oversight.WORKSHOP_ACTIVITIES).flat().find(item=>item.id===id);
const activeInterviewItems=()=>extended()?Oversight.SHORT_INTERVIEW_ITEMS:interviewQuestions.map((_,i)=>i+1);
const replayReceipt=()=>guided()?taskRecordLock:coreSurveyLock;
const participantPolicy=()=>session?.participantPolicyVersion||Oversight.CLASSIC_POLICY;
const sessionPlan=()=>trial?(Array.isArray(trial.initialPlan)&&trial.initialPlan.length?trial.initialPlan:P0):P0;
const stepLabel=id=>trial&&trial.labels&&Object.hasOwn(trial.labels,id)?trial.labels[id]:(LABELS[id]||id);
const stepLabels=()=>sessionPlan().map(stepLabel);
// Formal language is server-locked at preparation, before any P0 plan is shown.
let frozenLanguage=null,languageContext=null,entryLanguageCleanup=null;
const languageLocked=()=>frozenLanguage==='en'||frozenLanguage==='zh';
// The immutable design snapshot for this session. Frozen at enrollment; never re-read
// from a live setting. `design` is the resolved snapshot object used by the UI.
let design=null;
const coPlanning=()=>Boolean(design&&design.extensions&&design.extensions.initialCoPlanning.enabled);
// Co-planning was an explicit optional step of the extension. In the core study the
// standardized initial-plan review replaces it entirely.
const coPlanningActive=()=>coPlanning()&&typeof design.extensions.initialCoPlanning.mode==='string'&&design.extensions.initialCoPlanning.mode==='co_planning';
// The "involvement" manipulation checks belong to the extension only. The identifiers
// and wording are preserved verbatim so historical data stays comparable.
const showInvolvement=()=>coPlanning();
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Rendering helpers keep the *canonical* source of every dynamic node, so a language
// switch can re-render the text without the 100 ms tick ever seeing a difference, and
// without rebuilding forms, dialogs or any state the participant owns.
const htmlSource=new WeakMap();
const setHTML=(id,value)=>{const el=document.getElementById(id);if(!el)return false;if(htmlSource.get(el)===value)return false;htmlSource.set(el,value);HLLI18n.bindHTML(el,value);return true;};
const setText=(id,value)=>{const el=document.getElementById(id);if(el)HLLI18n.bindText(el,value);};
// Resolve the authoritative design snapshot for a session payload. The server sends a
// frozen `design` snapshot on every session/enroll response; the only fallback is the
// deterministic StudyDesign registry keyed by the canonical condition id. A legacy
// three-part cell without a snapshot resolves to the legacy protocol via designForCell
// (never reinterpreted as "extension disabled").
// Resolve the authoritative design snapshot for a session payload.
// The server sends a frozen `design` snapshot on every session/enroll response, so that
// snapshot is validated and used as-is. Only a session that predates the snapshot (an old
// row with no `design` at all) falls back to the deterministic registry keyed by its
// canonical condition id; a three-part cell there resolves to the legacy protocol rather
// than being reinterpreted as "the extension is off".
function resolveDesign(info){
  const snapshot=info&&info.design;
  if(snapshot)return StudyDesign.validateDesign(snapshot);
  return StudyDesign.designForCell(info.cell);
}
function view(next,label){if(entryLanguageCleanup){entryLanguageCleanup();entryLanguageCleanup=null;}stage=next;telemetry.setStage(next);HLLI18n.bindText(phaseLabel,label);document.body.classList.toggle('execution-mode',next==='execution');const pos=({setup:-1,comprehension:0,intro:0,'intro-rules':0,training:0,planning:1,'final-plan':1,execution:2,questionnaire:3,interview:3,done:3})[next];document.querySelector('#session-steps').innerHTML=['说明与练习','准备计划','监督执行','任务后回答'].map((x,i)=>`<li class="${i===pos?'active':''}" ${i===pos?'aria-current="step"':''}><span class="step-num">${i+1}</span>${x}</li>`).join('');window.scrollTo(0,0);}
const planVisible=()=>design?design.planVisibility==='high':(trial&&trial.cell.split('-')[1]==='H');
// The plan version the participant can actually see. In the low plan-visibility cell the
// panel does not exist, so nothing is exposed even though the script state is logged.
function recordPlanExposure(){if(!document.getElementById('plan'))return;const key=trial.plan.join(',')+'|'+trial.revision;if(key===lastPlanShown)return;lastPlanShown=key;telemetry.planShown(trial.plan,fast()?(trial.revisionApplied&&trial.design.planDynamics==='replanning'?'revised':'initial'):(trial.revision?'revised':'initial'),Math.max(1,trial.plan.indexOf(trial.currentId())+1));}
function focusHeading(){const h=app.querySelector('h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}}
function planHTML(){return '<ol class="plan">'+stepLabels().map(x=>`<li><span>${esc(x)}</span></li>`).join('')+'</ol>';}
function intro(){
  view('intro','活动背景');const started=performance.now();
  trial.record('narrative_view',{narrativeVersion:extended()?'2026-10-30-workshop-story-v02':SCENARIO.version});
  app.innerHTML=`<section class="sheet panel"><span class="eyebrow">THE SCENARIO</span><h2 class="intro-title">${esc(SCENARIO.title)}</h2><div id="scenario-story" class="story-copy">${(extended()?[...SCENARIO.paragraphs,'除了报名与邀请，你还需要让活动当天能够顺利进行：安排座位与投影设备、茶点送达、练习资料和现场分工。AI 助手会分三个连续章节处理这些事项，你继续担任负责人，按同一套要求监督。']:SCENARIO.paragraphs).map(p=>`<p>${esc(p)}</p>`).join('')}</div><p class="notice">${esc(SCENARIO.note)}</p><div class="actions"><button id="story-next" class="primary" data-tl="story-next">了解如何监督 →</button><span class="small">接下来先熟悉操作，再进入任务。</span></div></section>`;
  document.querySelector('#story-next').onclick=()=>{trial.record('narrative_complete',{narrativeVersion:extended()?'2026-10-30-workshop-story-v02':SCENARIO.version,exposureMs:performance.now()-started});roleInstructions();};focusHeading();
}
function taskReference(compact=false){const finalReview=v2()?'<li class="required-rule"><strong>发布前的最终审查</strong><span>任何面向参与者的资料发布或发送之前，必须完成预算、场地容量、报名字段、活动信息四项最终审查。</span></li>':'';return `<div class="panel-heading"><h2>任务要求</h2><span class="pill">始终可查</span></div><div class="task-summary"><div><span>参与人数</span>20 人</div><div><span>活动时间</span>14–16 时</div><div><span>预算上限</span>$5,000</div></div><ul class="required-list"><li><strong>场地</strong><span>至少容纳 20 人，有投影仪。</span></li><li><strong>预算</strong><span>场地与茶点合计 ≤ HK$5,000。</span></li><li><strong>报名字段</strong><span>姓名、邮箱、饮食偏好；不得收集 HKID／身份证号码。</span></li><li><strong>邀请邮件</strong><span>活动信息准确，使用符合要求的报名链接。</span></li>${finalReview}${extended()?'<li><strong>现场准备</strong><span>20 个座位；场地提供投影仪和 HDMI 线；参加者自带电脑，不另收费。</span></li><li><strong>内容与分工</strong><span>活动议程覆盖 14–16 时；提供无个人资料的示例数据、模板与说明；一名主持及一名志愿助教，无额外费用。</span></li><li><strong>茶点送达</strong><span>13:45 送至场地 A，保留素食选项，配送已含在套餐费用内。</span></li>':''}</ul><h3 class="rules-title">候选资料${compact?' · 场地均可用于 14–16 时':''}</h3><table class="facts-table"><thead><tr><th>选项</th><th>人数 / 配置</th><th>费用</th></tr></thead><tbody><tr><td>场地 A</td><td>24 人 · 投影仪</td><td>$2,800</td></tr><tr><td>场地 B</td><td>16 人 · 投影仪</td><td>$2,200</td></tr><tr><td>Basic</td><td>20 份 · 含素食</td><td>$1,600</td></tr><tr><td>Premium</td><td>20 份 · 含素食</td><td>$2,600</td></tr></tbody></table>${compact?'':'<p class="small">场地 A、B 均可用于 14:00–16:00。所有资料均为模拟数据。</p>'}`;}
let session=null;
const api=async(path,data)=>{const response=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:data===undefined?{}:{'Content-Type':'application/json','X-Study-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});let result;try{result=await response.json();}catch{throw new Error('connection_error');}if(!response.ok)throw new Error(result.error||'connection_error');return result;};
// Telemetry binding is safe for new, resumed and already completed sessions: attaching is
// idempotent per page, and a completed session simply records a short closing trace. The
// frozen design snapshot is recorded once and never re-derived from a live toggle.
function bindSession(info){if(!info||!info.id)return;if(info.bundle?.languageContext)languageContext=info.bundle.languageContext;if(['ready','running','completed'].includes(info.status))applyFrozenLanguage(info.language);telemetry.attach({sessionId:info.id,cell:info.cell,design,planVisible:planVisible()});telemetry.languageInitial(HLLI18n.getInitialLanguage());}
function bindTrial(instance){if(!instance)return;telemetry.setPlanVisibility(planVisible());telemetry.setTrial(instance);telemetry.attachTrial(instance);}
function applyFrozenLanguage(language){
  if(language!=='en'&&language!=='zh')return;
  frozenLanguage=null; // Authoritative session adoption precedes installing its guard.
  if(HLLI18n.getLanguage()!==language)HLLI18n.setLanguage(language);
  frozenLanguage=language;
  for(const button of document.querySelectorAll('.lang-switch [data-lang]')){
    button.disabled=false;
    button.title='正式部分的语言已确认，之后保持固定。';
    button.setAttribute('aria-pressed',String(button.getAttribute('data-lang')===language));
  }
}
let languageLockNoticeTimer=null;
function explainLanguageLock(){
  let note=document.getElementById('language-lock-note');
  if(!note){note=document.createElement('p');note.id='language-lock-note';note.className='language-lock-note';note.setAttribute('role','status');document.querySelector('.app-header').append(note);}
  HLLI18n.bindText(note,'正式部分的语言已确认，之后保持固定。请继续完成本次任务。');
  clearTimeout(languageLockNoticeTimer);languageLockNoticeTimer=setTimeout(()=>note.remove(),8000);
}
document.addEventListener('hll:beforelanguagechange',event=>{
  if(!languageLocked()||event.detail.to===frozenLanguage)return;
  event.preventDefault();explainLanguageLock();telemetry.languageAttempt(event.detail.from,event.detail.to);
});
function confirmFormalLanguage(){
  view('training','正式语言确认');
  app.innerHTML=`<section class="sheet panel"><h2>确认正式任务语言</h2><p>接下来将显示初始计划。请确认你要使用的语言，之后任务和问卷将保持该语言。</p><p>当前语言：<strong id="formal-language" translate="no">${HLLI18n.getLanguage()==='en'?'English':'中文'}</strong></p><p class="hint">如需修改，请使用右上角的语言选项。</p><button id="formal-language-confirm" class="primary" data-tl="formal-language-confirm">确认语言，查看计划 →</button><p id="formal-language-status" class="feedback" role="status"></p></section>`;
  document.querySelector('#formal-language-confirm').onclick=async()=>{
    const button=document.querySelector('#formal-language-confirm');button.disabled=true;
    try{
      let result;
      try{result=await api('prepare',{language:HLLI18n.getLanguage()});}
      catch(error){
        if(error.message!=='language_locked')throw error;
        const canonical=await api('session');
        if(!['ready','running','completed'].includes(canonical.status))throw error;
        if(canonical.status!=='ready'){await setup();return;}
        result={language:canonical.language,bundle:canonical.bundle};
      }
      trial.modelBundle=result.bundle;languageContext=result.bundle?.languageContext??null;
      session={...session,status:'ready',language:result.language,bundle:result.bundle};
      applyFrozenLanguage(result.language);finalPlan();
    }catch{setText('formal-language-status','未能确认语言，请检查网络后重试。');button.disabled=false;}
  };focusHeading();
}
function unavailable(message){view('setup','参与入口');app.innerHTML=`<section class="sheet panel"><h2>暂时无法继续</h2><p>${esc(message)}</p><p class="hint">请联系向你发送邀请码的研究者。</p></section>`;}
async function setup(){
 view('setup','参与入口');app.innerHTML='<section class="sheet panel"><h2>正在检查参与入口…</h2></section>';
 try{session=await api('session');if(session.status==='completed'){design=resolveDesign(session);bindSession(session);thankYou(session.id);return;}
 if(session.status==='running'){
  applyFrozenLanguage(session.language);
  let saved;try{saved=JSON.parse(localStorage.getItem('is6912-online-progress')||'null');}catch{}
  if(!saved||saved.id!==session.id||!saved.state){unavailable('测试页面曾中断，当前设备没有可恢复的记录。');return;}
  // The snapshot comes from the session record, so a reload can never replay the local
  // progress of one design (core vs extension) inside a session of another.
  design=resolveDesign(session);
  // Keys that only EXIST once the run has finished. A fresh Trial does not own them, so
  // copying only `Object.keys(trial)` would silently drop the recorded stop reason of a run
  // that was interrupted by the reload itself — and with it the correct primary outcome.
  // Everything else is still restricted to keys the live object owns, so nothing unknown
  // from storage is adopted.
  const RESTORED_WHEN_SET=['reason'];
  trial=new Trial(session.cell,session.id,1,design,participantPolicy());bindSession(session);bindTrial(trial);for(const key of Object.keys(trial))if(Object.hasOwn(saved.state,key)&&!['design','isFastPolicy','isExtended','participantPolicyVersion'].includes(key))trial[key]=saved.state[key];
  for(const key of RESTORED_WHEN_SET)if(saved.state[key]!==undefined&&saved.state[key]!==null)trial[key]=saved.state[key];
  if(!trial.ended){trial.protocolFlags.push('page_reloaded');trial.finish('technical_interruption');questionnaire();}
  else if(saved.stage==='interview'){interview();}else if(saved.stage==='done'){completed();}else{view('questionnaire','任务后回答');surveyAnswers=saved.surveyAnswers||{};surveyPage=saved.surveyPage||0;surveyStep();}return;
 }
 // A session that exists but has not started resumes at the same shared step it left, so
 // a reload after the P0 review returns to the comprehension check rather than restarting
 // the story. A brand-new session goes straight to the story, as it always did.
 design=resolveDesign(session);
 trial=new Trial(session.cell,session.id,1,design,participantPolicy());bindSession(session);bindTrial(trial);trial.record('ui_version',{version:UI_VERSION});
 if(session.status==='ready'){roleInstructions();return;}
 intro();return;
 }catch(error){if(error.message!=='session_required'&&error.message!=='session_expired'){unavailable('暂时无法连接参与服务，请稍后刷新。');return;}}
 const status=await api('status').catch(()=>({accepting:false}));
 if(status.protocolVersion===StudyDesign.PROTOCOL_VERSION){entryLanguageChoice(()=>renderEnrollment(status));return;}
 renderEnrollment(status);
}
function entryLanguageChoice(onConfirm){
 view('setup','选择语言');
 let chosen=null,deadline=0;
 app.innerHTML=`<section id="entry-language-choice" class="sheet panel language-choice"><span class="eyebrow">HUMAN LOOP LAB</span><h2>选择你的任务语言</h2><p>请选择你更熟悉的语言。说明与练习阶段仍可修改；正式部分开始前会再次确认。</p><div class="language-options" role="group" aria-label="选择语言"><button type="button" data-entry-lang="en" translate="no" lang="en" aria-pressed="false">English</button><button type="button" data-entry-lang="zh" translate="no" lang="zh-Hans" aria-pressed="false">中文</button></div><p id="entry-language-countdown" class="hint" role="status">请先选择一种语言。</p><button id="entry-language-confirm" class="primary" disabled>确认并继续 →</button></section>`;
 const confirm=document.querySelector('#entry-language-confirm');
 const update=()=>{
   if(!chosen)return;
   const left=Math.max(0,Math.ceil((deadline-performance.now())/1000));
   confirm.disabled=left>0;
   setText('entry-language-countdown',left?`确认前请稍候 ${left} 秒`:'可以确认。你也可以改选语言。');
 };
 const choose=language=>{
   if(language!=='en'&&language!=='zh')return;
   // Re-clicking the same choice does not restart a completed wait; a changed choice does.
   const changed=chosen!==language;chosen=language;
   HLLI18n.setLanguage(language);
   if(changed)deadline=performance.now()+3000;
   for(const button of app.querySelectorAll('[data-entry-lang]'))button.setAttribute('aria-pressed',String(button.dataset.entryLang===chosen));
   update();
 };
 for(const button of app.querySelectorAll('[data-entry-lang]'))button.onclick=()=>choose(button.dataset.entryLang);
 const onHeader=event=>{const button=event.target.closest?.('.lang-switch [data-lang]');if(button)choose(button.getAttribute('data-lang'));};
 document.addEventListener('click',onHeader,true);
 const clock=setInterval(update,100);
 const cleanup=()=>{clearInterval(clock);document.removeEventListener('click',onHeader,true);};entryLanguageCleanup=cleanup;
 confirm.onclick=()=>{
   if(!chosen||performance.now()<deadline)return;
   cleanup();entryLanguageCleanup=null;onConfirm();
 };focusHeading();
}
function renderEnrollment(status){
 app.innerHTML=`<section class="sheet panel"><span class="eyebrow">HUMAN LOOP LAB</span><h2 style="margin-top:8px">欢迎参加 AI 协作任务研究</h2><p>你将监督一个 AI 助手筹备校园活动。预计约 25–35 分钟（估计值），请使用电脑，并在开始后保持当前页面打开。</p><div class="notice">研究会记录你的操作步骤、点击间隔、你在页面上的停留时间与页面可见性变化，也会记录 AI 助手执行的每一个动作。问卷与访谈回答按你填写的内容保存。你可以随时关闭页面退出，未提交的内容不会被当作已完成。所有活动资料与操作均为模拟，不会真实发布或发送。请勿填写真实个人资料。</div><p class="small">说明和练习阶段可修改语言；正式计划显示前再确认并锁定。</p><form id="enroll"><label>邀请码<input type="text" name="invite" autocomplete="off" spellcheck="false" required></label><label class="check-row"><input type="checkbox" name="consent" required><span>我已阅读说明，自愿参与本次研究。</span></label><p id="entry-note" class="feedback" role="status">${status.accepting?'输入研究者提供的邀请码，确认资格后进入任务。':'当前暂未开放参与，请等待研究者通知。'}</p><button type="submit" class="primary" data-tl="enroll-submit" ${status.accepting?'':'disabled'}>验证邀请码，进入任务 →</button></form></section>`;
 document.querySelector('#enroll').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{session=await api('enroll',{invite:new FormData(e.target).get('invite').trim(),consent:true,language:HLLI18n.getLanguage(),supportedParticipantPolicy:Oversight.FAST_POLICY,supportedParticipantPolicies:[Oversight.FAST_POLICY,Oversight.GUIDED_POLICY,Oversight.EXTENDED_POLICY]});design=resolveDesign(session);trial=new Trial(session.cell,session.id,1,design,participantPolicy());bindSession(session);bindTrial(trial);trial.record('ui_version',{version:UI_VERSION});intro();}catch(error){setText('entry-note',error.message==='client_update_required'?'页面版本已更新，请刷新后使用同一个邀请码重试。':error.message==='registration_paused'?'当前参与入口已暂停，请联系研究者。':error.message==='invite_protocol_outdated'?'该邀请码属于旧版研究，无法用于本次任务，请联系研究者。':error.message==='invite_unavailable'?'邀请码不可用，请核对或联系研究者。':'邀请码不可用，请核对或联系研究者。');button.disabled=false;}};
}
/* ---------------------------------------------------- comprehension (v03 gate)
 *
 * The three fact checks are answered on the participant's own, before any of the run has
 * been shown, and every item must be right before `begin` is accepted. Per the contract the
 * server owns first-correctness, retry counts and completion timestamps and recomputes the
 * gate on `begin`; the client never declares itself "passed". A wrong answer gets ONE
 * neutral prompt (never mentioning the intervention event) and may be resubmitted. After a
 * second wrong attempt the shared task requirements are re-displayed and the item is
 * answered again — no wrong answer is ever carried into the run.
 *
 * A pre-v03 session has no `comprehension` block and goes straight to the story, exactly
 * as it did before this change.
 */
const COMPREHENSION_ITEMS=[
  {key:'beforePublication',question:'发布报名表之前，必须完成哪一项最终检查？',options:[['','请选择'],['review','完成最终合规审查'],['other_review','检查报名表配色']]},
  {key:'fields',question:'报名表允许收集哪些字段？',options:[['','请选择'],['name_email_diet','只收集姓名、邮箱、饮食偏好'],['other_fields','姓名、邮箱、饮食偏好和身份证号码']]},
  {key:'budget',question:'本次活动的总预算上限是多少？',options:[['','请选择'],['5000','HK$5,000'],['other_budget','HK$9,000']]},
];
// The single correct value per item. It is shown back on a retained item so a participant
// sees WHAT was accepted, not an empty disabled control.
const COMPREHENSION_CORRECT={beforePublication:'review',fields:'name_email_diet',budget:'5000'};
// Client-observed comprehension timing. Never authoritative and never a cross-clock
// subtraction: `comprehensionClient` records, on THIS page stream only, the first observed
// correct response for each item. An item that was already correct on a previous page (a
// reload) is left ABSENT rather than invented, because no same-stream observation exists.
let comprehensionClient=null;
/**
 * The in-flight comprehension attempt id (root review 19).
 *
 * ONE attempt id is minted per ANSWER SUBMISSION and then kept until the server has
 * acknowledged that submission. A transport failure (offline, timeout, 5xx) therefore
 * retries the SAME attempt, which the server treats idempotently, so a flaky network can
 * never inflate the participant's recorded retry count. A new id is minted only when the
 * participant genuinely changes their answers — which is a real retry — or after a success.
 */
let comprehensionAttemptId=null;
function mintAttemptId(){
  // `[A-Za-z0-9_-]{1,64}` is the accepted shape. The id only makes a retried POST
  // idempotent; the server still owns first-correctness and every attempt count.
  const bytes=new Uint8Array(16);
  if(typeof crypto!=='undefined'&&crypto.getRandomValues)crypto.getRandomValues(bytes);
  else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
  return 'a'+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
}
/** A different set of answers is a genuine new attempt, so it gets a new id. */
function answersFingerprint(answers){return JSON.stringify(Object.entries(answers).sort(([a],[b])=>a<b?-1:a>b?1:0));}
function comprehensionNeedsGate(){return v2()&&!(session&&session.comprehension&&session.comprehension.passed===true);}
/** Called after the P0 review clock, i.e. story -> instructions -> practice -> P0 -> here. */
function comprehensionGate(){
  if(!comprehensionNeedsGate()){startExecution();return;}
  renderComprehension(session&&session.comprehension?(session.comprehension.items||{}):{});
}
function renderComprehension(items){
  view('comprehension','任务理解核对');
  const retained={};
  for(const item of COMPREHENSION_ITEMS){
    // An item the server already holds as correct is RETAINED and its control is disabled,
    // and it DISPLAYS the accepted value rather than an empty placeholder.
    if(items[item.key]&&items[item.key].correct===true)retained[item.key]=COMPREHENSION_CORRECT[item.key];
  }
  app.innerHTML=`<div class="prep-grid"><aside class="panel">${taskReference()}</aside><section class="panel"><span class="eyebrow">COMPREHENSION</span><h2 style="margin-top:8px">任务理解核对</h2><p class="hint">请按任务要求回答这三项，之后才能开始监督。答错可以重试，系统会分别记录首次与后续尝试。</p><form id="comprehension">${COMPREHENSION_ITEMS.map(item=>{
    const done=Object.hasOwn(retained,item.key);
    return `<label class="${done?'check-row':''}">${esc(item.question)}<select name="${item.key}" required ${done?'disabled':''}>${item.options.map(([value,label])=>`<option value="${value}"${done&&value===retained[item.key]?' selected':''}>${esc(label)}</option>`).join('')}</select>${done?`<span class="small">${esc('回答正确，请继续。')}</span>`:''}</label>`;
  }).join('')}<p id="comprehension-feedback" class="feedback" role="status"></p><div class="actions"><button type="submit" class="primary" id="comprehension-submit" data-tl="comprehension-submit">提交答案 →</button></div></form></section></div>`;
  const form=document.querySelector('#comprehension');
  // A real native form submit: `required` is enforced by the browser before `onsubmit`
  // ever runs, so an unanswered item can never be posted.
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=document.querySelector('#comprehension-submit');
    button.disabled=true;
    // Only unanswered / still-wrong items travel; a retained correct item is never resent.
    const answers={};
    for(const item of COMPREHENSION_ITEMS){const control=form.elements[item.key];if(control&&!control.disabled&&control.value)answers[item.key]=control.value;}
    const fingerprint=answersFingerprint(answers);
    // Keep the SAME attempt id AND the SAME answers across a transport retry. The pending
    // request is re-sent verbatim, so a lost response can never turn one answer into two
    // attempts, and a mutated retry can never reuse an id with different content.
    if(!comprehensionAttemptId||comprehensionAttemptId.fingerprint!==fingerprint){
      comprehensionAttemptId={id:mintAttemptId(),fingerprint,answers:{...answers}};
    }
    const requestId=comprehensionAttemptId.id;
    const requestAnswers={...(comprehensionAttemptId.answers||answers)};
    try{
      const result=await api('comprehension',{attemptId:requestId,answers:requestAnswers});
      // The server has acknowledged this attempt: it is spent either way.
      comprehensionAttemptId=null;
      noteComprehensionClient(result,requestAnswers);
      session=Object.assign({},session,{comprehension:result});
      if(result.passed===true){
        trial.record('comprehension_complete',{firstCorrect:Object.fromEntries(COMPREHENSION_ITEMS.map(i=>[i.key,result.items?.[i.key]?.firstCorrect===true]))});
        setText('comprehension-feedback','三项都回答正确，可以开始监督。');
        startExecution();
        return;
      }
      // A wrong answer gets ONE neutral prompt, never mentioning the intervention event.
      // The screen is rebuilt so the retained items, their accepted values, their disabled
      // state and the new feedback are all visible together after every rerender.
      const wrong=COMPREHENSION_ITEMS.filter(i=>result.items?.[i.key]?.correct!==true);
      const message=wrong.length===COMPREHENSION_ITEMS.length?'仍不正确。请对照左侧任务要求再答一次。':'答案不正确。请对照左侧任务要求再试一次。';
      renderComprehension(result.items||{});
      setText('comprehension-feedback',message);
    }catch(error){
      // A transport failure keeps the SAME attempt id, so pressing submit again retries the
      // identical request instead of counting as another attempt.
      setText('comprehension-feedback','提交未成功，请检查网络后重试。');
      button.disabled=false;
    }
  };
  focusHeading();
}
/**
 * CLIENT-OBSERVED comprehension timing (root review 11 + 19).
 *
 * The gap to E2 is only meaningful within ONE page stream, so each item's correct
 * completion is stamped here only when THIS request on THIS stream has just made it
 * correct. An item that was already correct in the summary — because it was restored from
 * another page — is left absent, never invented. The server's own per-item timestamps stay
 * authoritative and are never mixed with these. The trial's `activeMs` is a script clock
 * that only starts at `begin`, so it is never used as "time since comprehension".
 */
function noteComprehensionClient(result,submitted){
  const items=result&&result.items;
  if(!items)return;
  if(!comprehensionClient||comprehensionClient.streamId!==telemetry.streamId){
    // A new page stream starts a fresh, empty observation set; entries from an older stream
    // are never carried over, because their clocks are not comparable.
    comprehensionClient={streamId:telemetry.streamId,items:{}};
  }
  const now=performance.now(),epoch=Date.now();
  for(const item of COMPREHENSION_ITEMS){
    const state=items[item.key];
    if(!state||state.correct!==true)continue;
    // Only an item THIS request just answered counts. A pre-existing correct item that
    // this request did not carry is not stamped here.
    if(!submitted||!Object.hasOwn(submitted,item.key))continue;
    if(comprehensionClient.items[item.key])continue;               // first correct wins
    comprehensionClient.items[item.key]={completedClientMs:Math.round(now),completedClientEpochMs:epoch};
  }
  if(preparation)preparation.comprehensionClient=comprehensionClient;
  if(trial&&trial.preparation)trial.preparation.comprehensionClient=comprehensionClient;
}
/**
 * Comprehension → E2 gap, computed ONCE, on the same stream, at the first E2 render.
 *
 * The guard runs BEFORE any timestamp is written, so the anchors can never be overwritten
 * by a later render. `trial.start()` clones `preparation`, and the export reads that clone,
 * so the anchors and gaps are mirrored onto `trial.preparation` as well. The overall
 * `completedGapMs` is the MINIMUM of the per-item gaps (the LATEST item completion), while
 * every per-item gap is preserved separately. Nothing is ever invented after a reload.
 */
function noteComprehensionToE2(){
  if(!v2()||!trial||trial.e2Start===null||trial.e2Start===undefined)return;
  // GUARD FIRST: if either copy already carries the block, NOTHING is written — not the
  // anchors and not the gaps — so a later render can never overwrite the first E2 stamp.
  if(preparation&&preparation.comprehensionToE2)return;
  if(trial.preparation&&trial.preparation.comprehensionToE2)return;
  const firstE2ClientMs=Math.round(performance.now()),firstE2ClientEpochMs=Date.now();
  for(const target of [preparation,trial&&trial.preparation]){
    if(!target)continue;
    target.firstE2ClientMs=firstE2ClientMs;
    target.firstE2ClientEpochMs=firstE2ClientEpochMs;
  }
  if(!comprehensionClient||comprehensionClient.streamId!==telemetry.streamId)return;
  const gapAt=(entry)=>entry?Math.max(0,firstE2ClientMs-entry.completedClientMs):null;
  const gaps={};
  for(const item of COMPREHENSION_ITEMS)gaps[item.key]=gapAt(comprehensionClient.items[item.key]);
  const observed=Object.values(gaps).filter(value=>typeof value==='number');
  const block={
    streamId:comprehensionClient.streamId,
    items:gaps,
    // MIN of the per-item gaps == the gap from the LATEST item completion.
    completedGapMs:observed.length===COMPREHENSION_ITEMS.length?Math.min(...observed):null,
    observedItems:observed.length,
    note:'client-observed, same page stream only; never a cross-clock subtraction',
  };
  for(const target of [preparation,trial&&trial.preparation])if(target)target.comprehensionToE2=block;
}
function roleInstructions(){view('intro-rules','监督说明');app.innerHTML=`<section class="sheet panel"><span class="eyebrow">YOUR ROLE</span><h2 class="intro-title">你是这场工作坊的组织者</h2><div class="intro-copy"><p>agent 将协助你安排场地、茶点、报名表和邀请邮件。<strong>你的任务是监督它的执行，并在认为有必要时介入。</strong></p><p class="hint">不需要自己完成所有操作，也不需要逐步点击批准。agent 会自动继续；它可能正确，也可能出错。</p></div><div class="instruction-cards"><div class="instruction-card"><h3>查阅要求</h3><p>执行时，任务要求和候选资料会一直显示在左侧。</p></div><div class="instruction-card"><h3>观察动作</h3><p>中间显示 agent 即将执行的内容和剩余时间。</p></div><div class="instruction-card"><h3>按需介入</h3><p>${fast()?'底栏可以暂停、调整步骤、继续或停止。':'底栏可以暂停、修改动作、调整方向、继续或停止。'}</p></div></div><h3>操作规则</h3><p class="hint">${fast()?'“调整步骤”会自动暂停。应用只安排步骤，不会立即执行；关闭窗口后仍然暂停，需点击“继续执行”。':'“修改动作”或“调整方向”会自动暂停。保存或关闭窗口后仍然暂停，需点击“继续执行”。暂停期间也有时间上限。'}</p><div class="intro-meta"><span>${extended()?'整场预计 6–8 分钟，按 10 分钟内设计；执行约 4 分钟（不含中断）':fast()?'监督执行约 2 分钟，不含暂停与回答时间（估计值）':v2()?'预计约 25–35 分钟（估计值）':'预计约 20–25 分钟'}</span><span>不会发生真实报名、发布或邮件发送</span></div><p class="small">任务记录你的操作步骤、点击与停留时间，以及 AI 助手执行的每一个动作。问卷与访谈回答按你填写的内容保存。${guided()?'问卷开始时可以参考本人的任务记录，提交核心回答后进入可选访谈。':fast()?'核心问题完成时会先保存，随后进入可选复盘。':''}你可以随时关闭页面退出。请勿填写真实个人资料。</p><div class="actions"><button id="train" class="primary" data-tl="training-start">先练习一次介入 →</button></div></section>`;document.querySelector('#train').onclick=training;focusHeading();}
function training(){if(fast())return stepPractice();view('training','操作练习');let paused=false,edited=false;
// The exit button names the step that actually follows. In the core study that is the
// standardized initial-plan review, never a plan the participant helped build.
const nextLabel=coPlanning()?'练习完成，准备计划 →':'练习完成，查看初始计划 →';app.innerHTML=`<section class="sheet panel"><span class="eyebrow">PRACTICE</span><h2 style="margin-top:8px">先练习：修改文件名</h2><p class="hint">要求保存为 <strong>meeting_notes.txt</strong>。当前准备使用另一个文件名，请按下方三步调整。</p><ol class="training-guide"><li id="practice1" class="active">1 · 暂停执行</li><li id="practice2">2 · 修改并保存</li><li id="practice3">3 · 继续执行</li></ol><div class="training-payload"><span class="small">当前文件名</span><p><code id="training-file" translate="no">notes.txt</code></p><span id="training-status" class="state-chip">运行</span></div><div class="training-controls"><button id="train-pause" data-tl="practice-pause">暂停</button><button id="train-edit" disabled data-tl="practice-edit">修改动作</button><button id="train-resume" disabled class="primary" data-tl="practice-resume">继续执行</button></div><div id="train-editor" class="training-editor" hidden><label>文件名<input id="filename" type="text" value="notes.txt"></label><button id="train-save" data-tl="practice-save">保存修改</button></div><p id="training-feedback" class="feedback" role="status">先点击“暂停”。</p><div class="actions"><button id="train-next" class="primary" disabled data-tl="practice-next">${nextLabel}</button></div></section>`;
  const mark=(done,active)=>{[1,2,3].forEach(i=>document.getElementById('practice'+i).className=i<=done?'done':i===active?'active':'');};
  document.querySelector('#train-pause').onclick=()=>{paused=true;setText('training-status','暂停');document.querySelector('#train-edit').disabled=false;mark(1,2);setText('training-feedback','已暂停。点击“修改动作”，调整文件名。');trial.record('training_pause');};
  document.querySelector('#train-edit').onclick=()=>{document.querySelector('#train-editor').hidden=false;document.querySelector('#filename').focus();};
  document.querySelector('#train-save').onclick=()=>{if(!paused)return;edited=document.querySelector('#filename').value.trim()==='meeting_notes.txt';trial.record('training_edit',{correct:edited});if(edited){setText('training-file','meeting_notes.txt');document.querySelector('#train-editor').hidden=true;document.querySelector('#train-resume').disabled=false;setText('training-feedback','文件名已修改；还没有恢复运行。点击“继续执行”。');mark(2,3);}else setText('training-feedback','请与要求中的文件名核对，再保存。');};
  document.querySelector('#train-resume').onclick=()=>{if(!edited)return;paused=false;mark(3,0);setText('training-status','已完成');setText('training-feedback','练习完成：暂停 → 修改并保存 → 继续执行。');document.querySelector('#train-next').disabled=false;document.querySelector('#train-pause').disabled=true;document.querySelector('#train-edit').disabled=true;document.querySelector('#train-resume').disabled=true;trial.record('training_complete');};document.querySelector('#train-next').onclick=()=>{if(coPlanning())planning();else finalPlan();};focusHeading();
}
function stepPractice(){
 view('training','操作练习');let paused=false,applied=false;
 app.innerHTML=`<section class="sheet panel"><span class="eyebrow">PRACTICE</span><h2>练习：安排一个文件处理步骤</h2><p>当前准备保存文件副本。请先安排“重命名文件”，再回到保存副本。</p><ol class="training-guide"><li>1 · 暂停</li><li>2 · 选择并应用步骤</li><li>3 · 继续</li></ol><div class="preview-card"><h3>当前动作</h3><p>保存文件副本</p></div><div class="actions"><button id="train-pause">暂停</button><button id="train-edit" disabled>调整步骤</button><button id="train-resume" disabled>继续执行</button></div><div id="train-editor" class="training-editor" hidden><label>先做哪个步骤？<select id="practice-choice"><option value="">请选择步骤</option><option value="rename">重命名文件</option><option value="open">打开文件夹</option></select></label><div id="practice-preview" class="local-sequence"></div><button id="train-save">应用步骤安排</button></div><p id="training-feedback" class="feedback">先暂停，再打开步骤安排。</p><button id="train-next" class="primary" disabled>练习完成，查看初始计划 →</button></section>`;
 document.querySelector('#train-pause').onclick=()=>{paused=true;trial.record('training_pause');document.querySelector('#train-edit').disabled=false;setText('training-feedback','已暂停。点击“调整步骤”。');};
 document.querySelector('#train-edit').onclick=()=>{document.querySelector('#train-editor').hidden=false;};
 document.querySelector('#practice-choice').onchange=e=>setHTML('practice-preview',e.target.value?`<span>${e.target.value==='rename'?'重命名文件':'打开文件夹'}</span><b aria-hidden="true">→</b><span>保存文件副本</span>`:'');
 document.querySelector('#train-save').onclick=()=>{if(!paused)return;if(document.querySelector('#practice-choice').value!=='rename'){trial.record('training_edit',{correct:false});setText('training-feedback','请按练习要求选择步骤。');return;}applied=true;trial.record('training_edit',{correct:true});document.querySelector('#train-editor').hidden=true;document.querySelector('#train-resume').disabled=false;setText('training-feedback','步骤已安排，尚未执行。点击“继续执行”。');};
 document.querySelector('#train-resume').onclick=()=>{if(!applied)return;paused=false;trial.record('training_complete');setText('training-feedback','已执行：重命名文件 → 保存文件副本。');document.querySelector('#train-next').disabled=false;for(const id of ['train-pause','train-edit','train-resume'])document.querySelector('#'+id).disabled=true;};
 document.querySelector('#train-next').onclick=finalPlan;focusHeading();
}
function planning(){
 // The planning screen only exists while the optional extension is enabled for THIS
 // session. Core participants skip it entirely, so no co-planning markup, control or
 // leftover copy is ever created, focused or announced.
 if(!coPlanning()){finalPlan();return;}
 view('planning','初始计划');prepStarted=performance.now();const co=coPlanningActive();app.innerHTML=`<div class="prep-grid"><aside id="source-panel" class="panel">${taskReference()}</aside><section class="panel"><span class="eyebrow">INITIAL PLAN</span><h2 style="margin-top:8px">${co?'与 agent 共同安排初始计划':'阅读 agent 的初始计划'}</h2><p class="hint">${co?'前面三个步骤已确定。请安排后面三个子目标，并把要求分配到对应步骤。':'请阅读下面的计划及对应要求，确认理解后继续。'}</p>${co?'<ol class="plan">'+sessionPlan().slice(0,3).map(x=>`<li><span>${esc(stepLabel(x))}</span></li>`).join('')+'</ol>':planHTML()}<div class="notice">依赖关系：先配置报名表，再检查带有报名链接的邮件；发布与发送放在配置和检查之后。</div><form id="planning-form">${co?`<h3 style="margin-top:18px">1 · 安排最后三个子目标</h3>${['第 4 步','第 5 步','第 6 步'].map((label,i)=>`<div class="form-row"><label for="order${i}">${label}</label><select id="order${i}" name="order${i}" required><option value="">请选择子目标</option><option value="form">配置报名表</option><option value="email">生成并检查邮件</option><option value="publish">发布表单并发送邀请</option></select></div>`).join('')}<h3 style="margin-top:20px">2 · 分配相关要求</h3>${[['fields','仅收集允许的报名字段'],['link','检查活动信息和报名链接'],['release','合规表单发布后发送邀请']].map(([key,label])=>`<div class="form-row"><label for="${key}">${label}</label><select id="${key}" name="${key}" required><option value="">选择对应子目标</option><option value="form">配置报名表</option><option value="email">生成并检查邮件</option><option value="publish">发布表单并发送邀请</option></select></div>`).join('')}`:`<h3 style="margin-top:18px">确认理解对应要求</h3>${['配置报名表：仅收集允许的字段。','生成邮件：检查活动信息和报名链接。','发布并发送：合规表单发布后发送邀请。'].map((label,i)=>`<label class="check-row"><input name="read${i}" type="checkbox" required><span>已阅读 · ${label}</span></label>`).join('')}`}<p id="planning-feedback" class="feedback" role="status"></p><div class="actions"><button type="submit" class="primary" data-tl="planning-submit">${co?'提交共同计划':'确认已读'} →</button>${co?'<button type="button" id="planning-help" data-tl="planning-assist">请 agent 完成安排</button>':''}</div></form></section></div>`;
  document.querySelector('#planning-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),values=Object.fromEntries(f);const matched=!co||(['form','email','publish'].every((x,i)=>f.get('order'+i)===x)&&f.get('fields')==='form'&&f.get('link')==='email'&&f.get('release')==='publish');trial.record('planning_attempt',{values});if(!matched){setText('planning-feedback','请再核对依赖关系与要求的对应步骤。也可以请求 agent 完成安排。');document.querySelector('#planning-feedback').scrollIntoView({block:'nearest'});return;}preparation={mode:co?'constrained_co_planning':'review_only',responses:values,assisted:false,durationMs:performance.now()-prepStarted};finalPlan();};document.querySelector('#planning-help')?.addEventListener('click',()=>{preparation={mode:'constrained_co_planning',assisted:true,durationMs:performance.now()-prepStarted};trial.record('planning_assistance');finalPlan();});focusHeading();
}
function finalPlan(){
 if(v2()&&!languageLocked()){confirmFormalLanguage();return;}
 view('final-plan','计划确认');const readStart=performance.now();let ready=false,read=false,readVisibleMs=0,readLast=readStart,readWasVisible=!document.hidden;
 // Core participants arrive here straight from the shared practice step. The standard
 // review is recorded with the same review_only preparation mode the extension's
 // review-only cells already used, so the two paths stay directly comparable. The
 // preparation clock starts when the practice step ends, which is the point the core
 // flow enters plan review.
 if(!preparation.mode){prepStarted=performance.now();preparation={mode:'review_only',responses:{},assisted:false,durationMs:0};}
 app.innerHTML=`<section class="sheet panel"><span class="eyebrow">READY TO RUN</span><h2 style="margin-top:8px">这是即将执行的初始计划</h2><p class="hint">请阅读计划。开始后 AI 助手将自动执行，你可以随时使用底栏介入。</p>${planHTML()}<div class="notice">${fast()?'调整步骤会暂停执行；应用后仍需手动继续。任务要求和候选资料会一直显示在左侧。':'修改动作会暂停执行；保存后要点击“继续执行”。任务要求和候选资料会一直显示在执行界面左侧。'}</div><p id="model-status" class="feedback" role="status">助手正在准备本次任务，请稍候。</p><div class="actions"><button id="start" class="primary" disabled data-tl="task-start">开始监督 →</button><button id="prepare-retry" hidden data-tl="prepare-retry">重试准备</button><span id="read-time" class="small"></span></div></section>`;
 // The review screen is replaced the moment the run starts, so every later write (the
 // prepare response, the reading clock) must tolerate the screen already being gone.
 const update=()=>{const start=document.querySelector('#start');if(start)start.disabled=!(ready&&read);};
 const sampleRead=()=>{const now=performance.now();if(readWasVisible)readVisibleMs+=now-readLast;readLast=now;readWasVisible=!document.hidden;};
 document.addEventListener('visibilitychange',sampleRead);
 const clock=setInterval(()=>{if(stage!=='final-plan'){clearInterval(clock);document.removeEventListener('visibilitychange',sampleRead);return;}sampleRead();const left=Math.max(0,Math.ceil(((guided()?5000:20000)-(fast()?readVisibleMs:performance.now()-readStart))/1000));const time=document.querySelector('#read-time');if(time)setText('read-time',left?`请先阅读 · ${left} 秒`:'');if(!left){clearInterval(clock);document.removeEventListener('visibilitychange',sampleRead);read=true;update();}},100);
 const prepare=async()=>{const retry=document.querySelector('#prepare-retry');if(retry)retry.hidden=true;const status=document.querySelector('#model-status');if(!status)return;setText('model-status','助手正在准备本次任务，请稍候。');try{const result=trial.modelBundle?{bundle:trial.modelBundle}:await api('prepare',{});trial.modelBundle=result.bundle;ready=true;if(!document.querySelector('#model-status'))return;setText('model-status','助手已准备好。阅读完计划后，可以开始。');update();}catch{if(!document.querySelector('#model-status'))return;setText('model-status','助手暂时未能完成准备。你可以重试；若仍失败，请联系研究者。');const again=document.querySelector('#prepare-retry');if(again)again.hidden=false;}};
 document.querySelector('#prepare-retry').onclick=prepare;prepare();
 document.querySelector('#start').onclick=()=>{const button=document.querySelector('#start');if(button)button.disabled=true;preparation.finalPlanReadMs=fast()?readVisibleMs:performance.now()-readStart;if(fast()){preparation.finalPlanVisibleMs=readVisibleMs;preparation.finalPlanWallMs=performance.now()-readStart;}preparation.durationMs=Math.max(preparation.durationMs||0,preparation.finalPlanReadMs);comprehensionGate();};focusHeading();
}
/**
 * Entering the run.
 *
 * A v03 session still has to clear the comprehension gate the server owns; a pre-v03
 * session has no gate and goes straight through, exactly as before this change. There is
 * no intro/practice loop on completion: a passed gate always lands in the execution screen.
 */
async function startExecution(){
 try{await api('begin',{});}
 catch(error){
  // The server recomputes the gate, so a refusal here is authoritative: return to the
  // check instead of pretending the run started.
  if(error.message==='comprehension_required'){
    const fresh=await api('comprehension').catch(()=>null);
    if(fresh&&!fresh.passed){session={...session,comprehension:fresh};renderComprehension(fresh.items||{});return;}
    unavailable('当前测试无法开始，请联系研究者。');return;
  }
  if(error.message==='trial_already_started'){unavailable('本次任务已经启动，请刷新页面核对记录；若无法恢复，请联系研究者。');return;}
  unavailable('当前测试无法开始，请联系研究者。');return;
 }
 view('execution','监督执行');telemetry.setPlanVisibility(planVisible());trial.start(preparation);trial.record(v2()?'script_prepared':'live_models_prepared');executionShell();renderExecution();telemetry.transition();
 lastTick=performance.now();runExecutionTimer();
}
function advanceExecutionClock(){const now=performance.now();trial.tick(now-lastTick);lastTick=now;}
function runExecutionTimer(){clearInterval(timer);timer=setInterval(()=>{if(stage!=='execution')return;advanceExecutionClock();persist();if(trial.ended){clearInterval(timer);questionnaire();}else renderExecution();},100);}
function holdForVisibility(){
 if(!fast()||stage!=='execution'||trial.ended)return;
 if(!trial.systemHeld){advanceExecutionClock();if(trial.ended){clearInterval(timer);questionnaire();return;}trial.systemHold();}
 clearInterval(timer);telemetry.setSystemHeld(true);telemetry.setPlanVisibility(false);document.body.classList.add('system-held');app.inert=true;persist();
}
function showVisibilityReturn(){
 if(!fast()||!trial.systemHeld||stage!=='execution'||trial.ended)return;
 advanceExecutionClock();trial.systemReturn();const modal=document.querySelector('#visibility-return');if(!modal.open)modal.showModal();persist();
}
function confirmVisibilityReturn(){
 if(document.hidden||!trial?.systemHeld)return;advanceExecutionClock();trial.releaseSystemHold();document.querySelector('#visibility-return').close();document.querySelector('#held-return-control').hidden=true;document.body.classList.remove('system-held');app.inert=false;telemetry.setSystemHeld(false);telemetry.setPlanVisibility(planVisible());lastTick=performance.now();renderExecution();persist();runExecutionTimer();
}

function executionShell(){const high=planVisible();app.innerHTML=`<div class="workspace"><aside id="source-panel" class="panel">${taskReference(true)}</aside><section class="panel action-panel"><div class="panel-heading"><h2>当前动作预览</h2><span id="status" class="state-chip" aria-live="polite"></span></div>${v2()?'<div id="system-update" class="notice" aria-live="polite" hidden></div>':''}<div id="current-action"></div><div class="clock-box"><div><span id="clock-label"></span><p id="clock-hint"></p></div><strong id="remaining" role="timer"></strong></div><p class="execution-hint">与左侧任务要求核对。是否介入，由你判断；无需逐步确认。</p></section><div class="side-stack">${high?'<aside id="plan-panel" class="panel plan-panel"><div class="panel-heading"><h2>执行计划</h2><span class="pill">实时状态</span></div><div id="revision" class="notice"></div><ol id="plan" class="plan"></ol></aside>':'<div class="empty-slot" aria-hidden="true"></div>'}<aside id="trace-panel" class="panel trace-panel"><div class="panel-heading"><h2>已发生动作</h2></div><ol id="trace" class="trace"></ol></aside></div></div><footer class="intervention-bar"><div class="bar-status"><strong id="bar-title">agent 正在运行</strong><p id="bar-hint">如需介入，可直接修改动作或先暂停。</p></div><div class="intervention-controls"><button id="pause" title="只暂停，不修改内容" data-tl="exec-pause">暂停</button>${fast()?'':'<button id="override" title="自动暂停并打开当前动作编辑器" data-tl="exec-override">修改动作</button>'}<button id="redirect" title="自动暂停，调整后续处理方式" data-tl="exec-redirect">${fast()?'调整步骤':'调整方向'}</button><button id="stop" title="终止本次工作流，进入任务后回答" data-tl="exec-stop">停止任务</button><span class="divider" aria-hidden="true"></span><button id="resume" class="primary" disabled data-tl="exec-resume">继续执行</button></div></footer>`;
  document.querySelector('#pause').onclick=()=>{telemetry.decision('pause');trial.pause();renderExecution();persist();};document.querySelector('#override')?.addEventListener('click',openEditor);document.querySelector('#redirect').onclick=openRedirect;document.querySelector('#stop').onclick=()=>{telemetry.decision('stop');trial.stop();clearInterval(timer);persist();questionnaire();};document.querySelector('#resume').onclick=()=>{trial.resume();trial.record('resume_ui');renderExecution();persist();};
  for(const [id,area] of [['source-panel','source'],['trace','trace'],['plan','plan']]){const el=document.getElementById(id);el?.addEventListener('pointerenter',()=>trial.record('information_view',{area}));const scrollRegion=el?.closest('.panel');scrollRegion?.addEventListener('scroll',()=>trial.record('panel_scroll',{area,scrollTop:scrollRegion.scrollTop}),{passive:true});}
}
function actionHTML(){if(extended()&&trial.workshopScenes().length)return extendedActionHTML();const p=trial.payload;const fields=p.fields.map(x=>`<span>${NAMES[x]}</span>`).join('');
  // The review step is an ORDINARY scripted action: no alarm styling, no special colour,
  // nothing that marks it as the answer to the manipulation. It is rendered exactly like
  // every other step preview.
  if(trial.phase==='review')return '<h3 class="action-title">最终合规审查</h3><p class="action-subtitle">正在逐项核对发布前的四项要求。</p><div class="preview-card"><div class="preview-label">逐项核对</div><ul class="review-checks"><li>预算合计 ≤ HK$5,000</li><li>容量 ≥ 20 人</li><li>仅收集允许的三项字段</li><li>活动信息与报名链接准确</li></ul></div>';
  if(trial.phase==='brief')return '<h3 class="action-title">核对目标与约束</h3><p class="action-subtitle">agent 正在读取本次工作坊的任务要求。</p><div class="preview-card"><p>人数、时间、场地、预算、报名字段与邀请链接。</p></div>';
  if(trial.phase==='event')return '<h3 class="action-title">收到资源资料更新</h3><p class="action-subtitle">新的资料已加入本次任务。</p><div class="preview-card"><p>两份资源资料均已到齐。茶点供应商补发了菜单说明；场地与茶点均可先处理，价格和可用性不变。</p></div>';
  if(trial.phase==='resource'){const venue=trial.currentId()==='venue';return `<h3 class="action-title">${venue?'选择场地':'选择茶点'}</h3><p class="action-subtitle">agent 准备使用以下选项。</p><div class="preview-card"><div class="preview-label">待执行选择</div><dl><dt>${venue?'场地':'套餐'}</dt><dd>${venue?'场地 '+p.venue:p.catering}</dd><dt>对应资料</dt><dd>${venue?(p.venue==='A'?'24 人 · 投影仪 · HK$2,800':'16 人 · 投影仪 · HK$2,200'):(p.catering==='Basic'?'20 份 · 含素食 · HK$1,600':'20 份 · 含素食 · HK$2,600')}</dd></dl></div>`;}
  if(trial.phase==='form')return `<h3 class="action-title">配置报名表</h3><p class="action-subtitle">agent 准备把这些字段加入报名表。</p><div class="preview-card"><div class="preview-label">报名字段</div><div class="field-tags">${fields}</div></div>`;
  if(trial.phase==='email')return `<h3 class="action-title">生成并检查邀请邮件</h3><p class="action-subtitle">agent 准备使用以下活动信息。</p><div class="preview-card"><dl><dt>主题</dt><dd>邀请：20 人工作坊</dd><dt>时间与地点</dt><dd>14:00–16:00 · 场地 ${p.venue}</dd><dt>报名链接</dt><dd>模拟报名表</dd></dl></div>`;
  if(trial.phase==='publish')return `<h3 class="action-title">发布报名表</h3><p class="action-subtitle">agent 即将发布以下内容，随后发送工作坊邀请。</p><div class="preview-card"><div class="preview-label">待发布字段</div><div class="field-tags">${fields}</div><p class="small">发布后，邀请邮件将指向这份报名表。</p></div>`;
  return '<h3 class="action-title">发送邀请邮件</h3><p class="action-subtitle">报名表已发布，agent 准备发送邀请。</p><div class="preview-card"><p>20 人工作坊 · 14:00–16:00 · 模拟报名链接</p></div>';
}
function extendedActionHTML(){
 const scenes=trial.workshopScenes(),index=Math.max(0,trial.workshopActivityIndex),item=scenes[index];
 const chapter=trial.phase==='email'?'现场与内容准备':'资源与报名准备';
 return `<p class="eyebrow">${chapter}</p><h3 class="action-title">${esc(item.title)}</h3><p class="action-subtitle"><span>${esc(stepLabel(trial.phase))}</span><span translate="no"> · </span><span translate="no">${index+1}/${scenes.length}</span></p><div class="preview-card"><div class="preview-label">当前细项</div><p>${esc(item.detail)}</p></div><p class="small">本页只展示正在处理的内容。助手会继续执行，无需逐项批准。</p>`;
}
// One plan renderer for BOTH the pre-run review and the live panel, so a row can never
// acquire different markup in the two places. Rows keep their index for their whole life:
// at E2 the pointer moves into `publish` while `review` stays an ordinary pending row in
// the SAME position, with the SAME classes and the SAME visual grammar. No row is ever
// reordered, recoloured, highlighted or flashed, and nothing about E2 is special-cased.
function planRowsHTML(plan,{states=false}={}){
  const current=trial&&trial.currentId?trial.currentId():null;
  return plan.map(x=>{
    const done=trial&&trial.completed.includes(x);
    const isCurrent=states&&current===x;
    const scheduled=trial&&trial.pendingRecovery&&trial.pendingRecovery.step===x;
    const cls=done?'complete':isCurrent?'current':'';
    const status=done?'已完成':isCurrent?'当前':scheduled?'待执行':'待执行';
    const note=scheduled&&!done?`<span class="plan-scheduled">${esc('已排入步骤，尚未执行。')}</span>`:'';
    return `<li class="${cls}" data-step="${esc(x)}"><span><span class="plan-status">${esc(status)}</span><span class="plan-text">${esc(stepLabel(x))}</span>${note}</span></li>`;
  }).join('');
}
/** The review notice is the ONLY ordinary-state text; it never mentions the intervention. */
function revisionNotice(){
  if(trial&&trial.pendingRecovery)return '已恢复：最终合规审查';
  return (trial&&trial.revision)||'按初始顺序执行。';
}
function renderExecution(){
  if(stage!=='execution'||trial.ended)return;
  if(extended()&&trial.workshopScenes().length){const item=trial.workshopScenes()[Math.max(0,trial.workshopActivityIndex)];if(lastWorkshopView!==item.id){lastWorkshopView=item.id;trial.record('workshop_activity_view',{activityId:item.id,visible:!document.hidden&&!trial.systemHeld,focused:document.hasFocus()});}}
  // The first E2 render is the only place a comprehension→E2 gap is computed, and only on
  // this page stream. Never a cross-clock subtraction, never an invented value.
  if(trial.e2Start!==null&&trial.e2Start!==undefined)noteComprehensionToE2();
  // The chip carries the STATE, while the bottom-bar button carries the ACTION: "Paused"
  // on the chip, "Pause" on the button. They are never the same word.
  setText('status',trial.paused?'已暂停':'运行');
  setHTML('current-action',actionHTML());
  const update=document.getElementById('system-update');
  if(update){
    const visible=trial.activeMs>=(fast()?10000:20000)&&trial.activeMs<(fast()?40000:50000);
    if(visible&&update.hidden)setText('system-update','系统更新：报名表服务提前可用。报名表仅需姓名、邮箱和饮食偏好，可独立于场地和茶点配置。场地、茶点、价格及任务要求均不变。');
    update.hidden=!visible;
  }

  if(fast())setText('bar-hint',trial.paused?'应用后仍需点击“继续执行”。':'如需介入，可以暂停或调整步骤。');
  const seconds=Math.max(0,Math.ceil((trial.paused?60000*trial.pace-trial.pauseMs:trial.duration()-trial.phaseMs)/1000));
  setText('remaining',seconds+' 秒');
  setText('clock-label',trial.paused?'暂停剩余时间':'自动继续倒计时');
  setText('clock-hint',trial.paused?'计时已冻结；保存后需手动继续。':'没有介入时，agent 会自动继续。');
  setText('bar-title',trial.paused?'agent 已暂停':'agent 正在运行');
  setText('bar-hint',trial.paused?(fast()&&trial.pendingRecovery?'你的步骤安排已保存，继续后才会执行。':'检查当前预览后，点击“继续执行”。'):fast()?'如需介入，可以暂停或调整步骤。':'如需介入，可直接修改动作或先暂停。');
  const pauseButton=document.querySelector('#pause');if(pauseButton)pauseButton.disabled=trial.paused;
  const resumeButton=document.querySelector('#resume');if(resumeButton)resumeButton.disabled=!trial.paused||trial.editorOpen;
  const historyPanel=document.querySelector('.trace-panel');
  const followHistory=historyPanel&&historyPanel.scrollTop+historyPanel.clientHeight>=historyPanel.scrollHeight-12;
  const historyItems=extended()?trial.events.filter(e=>e.type==='workshop_activity_completed'||e.type==='public_step_completed').map(e=>e.type==='workshop_activity_completed'?activityById(e.data.activityId)?.title:stepLabel(e.data.step)):trial.trace;
  const history=historyItems.length?historyItems.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>尚无已完成动作。</li>';
  if(setHTML('trace',history)&&followHistory){telemetry.markAutoScroll('trace');historyPanel.scrollTop=historyPanel.scrollHeight;}
  setText('revision',revisionNotice());
  // The plan list is rebuilt from the plan array, so a row keeps its index; `review` is
  // rendered by exactly the same three states as every other row.
  setHTML('plan',planRowsHTML(trial.plan,{states:true}));
  setText('edit-timer','暂停剩余 '+seconds+' 秒 · 保存后仍需继续执行');
  setText('direction-timer','暂停剩余 '+seconds+' 秒 · 应用后仍需继续执行');
  telemetry.setExecution(trial.phase,trial.currentId());
  recordPlanExposure();
}
const dialog=document.querySelector('#editor'),direction=document.querySelector('#direction');
/**
 * The action editor.
 *
 * On the current protocol every payload control here is an accepted no-op: the scripted v03
 * agent has no HKID field to remove and no editable venue/catering choice, so offering them
 * would let a participant press "save" and change nothing (root review 14). They are
 * therefore DISABLED and the dialog says so plainly instead of pretending to offer an
 * edit that silently does nothing. The pending-action edit authority that the legacy
 * protocols really did honour is preserved exactly, controls and validation included.
 */
function openEditor(){
  telemetry.editorOpen('override');trial.pause('override_open');trial.editorOpen=true;
  const f=document.querySelector('#edit-form'),box=document.querySelector('#editor-unavailable');
  if(v2()){
    if(box)box.hidden=false;
    for(const el of f.querySelectorAll('select,input[type=checkbox]'))el.disabled=true;
    setText('editor-note','本次任务中，待执行动作的内容不可更改；如需调整处理方式，请使用底栏的“调整方向”。');
  }else{
    if(box)box.hidden=true;
    f.elements.venue.value=trial.payload.venue;f.elements.catering.value=trial.payload.catering;
    f.elements.venue.disabled=trial.completed.includes('venue');f.elements.catering.disabled=trial.completed.includes('catering');
    for(const checkbox of f.querySelectorAll('[name=field]'))checkbox.checked=trial.payload.fields.includes(checkbox.value);
    f.elements.order.value=trial.plan.indexOf('venue')<trial.plan.indexOf('catering')?'venue-first':'catering-first';
    f.elements.order.disabled=trial.completed.includes('venue')||trial.completed.includes('catering');
  }
  renderExecution();dialog.showModal();trial.record('editor_open');
}
function closeEditor(saved){trial.editorOpen=false;telemetry.editorClose('override',saved);dialog.close();renderExecution();}
document.querySelector('#cancel-edit').onclick=()=>{trial.record('editor_cancel');closeEditor(false);};dialog.addEventListener('cancel',()=>{telemetry.editorClose('override',false);trial.editorOpen=false;trial.record('editor_cancel');renderExecution();});
document.querySelector('#edit-form').onsubmit=e=>{
  e.preventDefault();
  if(v2()){closeEditor(false);persist();return;}
  const f=new FormData(e.target),changes={fields:f.getAll('field')};for(const key of ['venue','catering','order'])if(f.has(key))changes[key]=f.get(key);trial.edit(changes);closeEditor(true);persist();
};
/**
 * "Change direction" — the GENERIC recovery control.
 *
 * It offers a generic "insert or restore a step before the current action" plus the
 * pre-existing directions. Nothing is preselected and no full pending plan is shown, so
 * the control never reveals which step the design expects (root review 4 + contract). On
 * the current protocol the restore goes through `edit({restoreStep})`; `redirect()` is
 * never called, because on v03 it means a plain stop and that would silently terminate a
 * run over a choice the participant never made.
 */
function openRedirect(){
  document.querySelector('#local-adjustment').hidden=!fast();
  if(fast()){setText('direction-title','调整当前动作之前的步骤');setText('direction-help','选择你认为需要先做的步骤。预览只表示你的安排，不会替你判断。');}
  telemetry.editorOpen('direction');trial.pause('redirect_open');trial.editorOpen=true;
  const choice=document.querySelector('#redirect-choice');
  if(v2()){
    // A fixed action catalogue is NOT the active plan: no order numbers, completion
    // states or treatment-dependent choices. Nothing is selected on opening.
    const choices=['brief','catering','email','form','publish','review','send','venue'];
    setHTML('redirect-choice','<option value="">请选择步骤</option>'+choices.map(id=>`<option value="${id}">${esc(stepLabel(id))}</option>`).join(''));
    choice.required=true;choice.value='';
    setText('direction-note','选择要在当前动作之前执行的步骤。应用只安排步骤，仍需点击继续执行。');
  }else{
    const resourcesDone=trial.completed.includes('venue')||trial.completed.includes('catering');
    for(const option of choice.options)option.disabled=option.value==='restore-review'||(option.value!=='safe-form'&&resourcesDone);
    choice.value='safe-form';
    setText('direction-note',resourcesDone?'资源步骤已开始，不能再交换资源顺序。仍可选择任务要求中的报名模板。':'资源步骤尚未开始，可以调整资源顺序，或选择任务要求中的报名模板。');
  }
  updateAdjustmentPreview();renderExecution();direction.showModal();trial.record('direction_open');
}
function updateAdjustmentPreview(){
 if(!fast())return;const selected=document.querySelector('#redirect-choice').value;
 setText('adjust-current',stepLabel(trial.currentId()));setHTML('adjust-proposal',selected?`<span>${esc(stepLabel(selected))}</span><b aria-hidden="true">→</b><span>${esc(stepLabel(trial.currentId()))}</span>`:'<span>先选择一个步骤，预览会显示在这里。</span>');
}
document.querySelector('#redirect-choice').addEventListener('change',()=>{updateAdjustmentPreview();const step=document.querySelector('#redirect-choice').value;if(fast()&&step)trial.record('direction_selection',{step});});
function closeDirection(saved){trial.editorOpen=false;telemetry.editorClose('direction',saved);direction.close();renderExecution();}
document.querySelector('#cancel-redirect').onclick=()=>{trial.record('direction_cancel');closeDirection(false);};direction.addEventListener('cancel',()=>{telemetry.editorClose('direction',false);trial.editorOpen=false;trial.record('direction_cancel');renderExecution();});
document.querySelector('#direction-form').onsubmit=e=>{
  e.preventDefault();
  const value=document.querySelector('#redirect-choice').value;
  if(v2()){
    try{trial.edit({restoreStep:value});closeDirection(true);persist();return;}
    catch{setText('direction-note','当前不能在这里执行这个步骤。请选择其他步骤，或关闭窗口继续观察。');trial.record('invalid_recovery',{step:value});persist();return;}
  }
  if(value==='safe-form')trial.redirect();else trial.edit({order:value});
  closeDirection(true);persist();
};
const ratingItems=[['dynamics','The agent changed the order of its remaining plan during execution.'],['visibility1','During execution, I could inspect the agent’s current plan.'],['visibility2','I could see which steps remained and their order.'],['involvement1','I actively helped construct the initial plan.'],['involvement2','My actions contributed to how the initial plan was organized.'],['authority','I was allowed to pause, change a pending action, and resume execution.'],['control1','I could intervene at the right moment.'],['control2','I could bring the workflow back in line with my requirements.'],['difficulty','The task was difficult.'],['effort','Understanding the agent required mental effort.'],['timePressure','I felt under time pressure.'],['competence','The agent handled the task competently.'],['trust','I would trust the agent’s subsequent actions.']];
// The co-planning manipulation checks (involvement1 / involvement2) only belong to the
// extension. In the core study they are omitted entirely. Their identifiers and wording
// are preserved verbatim so extension and historical data stay directly comparable.
const firstChecks=()=>ratingItems.slice(0,3).concat(showInvolvement()?ratingItems.slice(3,5):[]).concat([fast()?['authority','I was allowed to pause, arrange a step before the current action, and resume execution.']:ratingItems[5]]);
const experienceChecks=()=>ratingItems.slice(6);
function rating(key,text){return `<fieldset><legend>${text}</legend><div class="rating">${[1,2,3,4,5,6,7].map(n=>`<label><input required type="radio" name="${key}" value="${n}">${n}</label>`).join('')}</div></fieldset>`;}
function questionnaire(){view('questionnaire','任务后回答');if(dialog.open)dialog.close();if(direction.open)direction.close();surveyPage=0;surveyAnswers={};persist();surveyStep();}
function surveyStep(){if(guided())return guidedSurveyStep();const revised=design?design.planDynamics==='replanning':trial.cell[0]==='R';const titles=['回忆刚才的执行','计划与参与体验','监督体验'];
 // The post-task UNPROMPTED current-plan recall and the "when did you notice" item are
 // asked on the FIRST page, before any leading manipulation check on page 2, and without
 // any execution probe: the participant simply writes the order they remember. Noticing
 // the revision is NOT scored as a manipulation failure (an R-L participant who did not
 // notice it is a valid outcome); only the H-cell recognition and the stable-cell false
 // positives are checked, from these answers. Every item is optional-safe: leaving it blank
 // is a real answer ("I do not remember"), never a missing value.
 const legacyRecall=`<label>资料更新后，agent 的资源顺序<select name="recalledOrder" required><option value="">请选择</option><option value="venue-first">场地 → 茶点</option><option value="catering-first">茶点 → 场地</option><option value="unsure">不确定</option><option value="not-reached">未观察到该阶段</option></select></label><label>你认为 agent 有没有改计划？<select name="recalledChange" required><option value="">请选择</option><option value="unchanged">保持原计划</option><option value="reordered">改变顺序</option><option value="unsure">不确定</option></select></label><label>最后一次动作预览中，agent 处于哪个子目标？<input name="currentSubgoal" type="text" required></label><label>当时如果你不介入，agent 下一步会做什么？<input name="predictedNext" type="text" required></label><label>你是否发现需要纠正的地方？说明当时的依据。<textarea name="diagnosis" required></textarea></label>`;
 const commonRecall=fast()?`<label>在你第一次主动操作（暂停、调整或停止）之前，Agent 当时准备执行什么？若未介入，请以结束前最后一次观察为准。<input name="currentSubgoal" type="text" required></label><label>就在上述时刻，如果你不介入，你认为下一步会发生什么？<input name="predictedNext" type="text" required></label><label>你当时是否认为需要调整？请说明依据；不记得或未观察到也可以直接写明。<textarea name="diagnosis" required></textarea></label>`:`<label>最后一次动作预览中，agent 处于哪个子目标？<input name="currentSubgoal" type="text" required></label><label>当时如果你不介入，agent 下一步会做什么？<input name="predictedNext" type="text" required></label><label>你是否发现需要纠正的地方？说明当时的依据。<textarea name="diagnosis" required></textarea></label>`;
 const freeRecall=`<label>服务更新后，你认为 agent 当时的计划是什么？<textarea name="planAfterUpdate" required></textarea></label><label>如果有，你在什么时候意识到执行顺序发生了变化？当时依据是什么？<textarea name="noticedChangeWhen" required></textarea></label>`;
 const recall=v2()?freeRecall+commonRecall:legacyRecall;
 const objectiveRecall=v2()?`<label>资料更新后，agent 的工作顺序<select name="workOrderAfterUpdate" required><option value="">请选择</option><option value="venue-catering-form">场地 → 茶点 → 报名表</option><option value="form-venue-catering">报名表 → 场地 → 茶点</option><option value="other">其他顺序</option><option value="unsure">不确定</option><option value="not-reached">未观察到该阶段</option></select></label><label>你认为 agent 有没有改计划？<select name="recalledChange" required><option value="">请选择</option><option value="unchanged">保持原计划</option><option value="reordered">改变顺序</option><option value="unsure">不确定</option></select></label>`:'';
 const checks=objectiveRecall+firstChecks().map(x=>rating(...x)).join('')+(revised?rating('revisionWhen','I could identify when the plan was revised.')+rating('revisionWhat','I could identify which steps changed order.')+'<label>具体改变了什么？你从哪里发现？<textarea name="revisionEvidence" required></textarea></label>':'')+`<label>正式权限核对<select name="authorityCheck" required><option value="">请选择</option><option value="all">${fast()?'我可以暂停、安排执行步骤并继续':'我可以暂停、修改待执行动作并继续'}</option><option value="pause-only">我只能暂停</option><option value="unsure">不确定</option></select></label>`;const experience=experienceChecks().map(x=>rating(...x)).join('');app.innerHTML=`<section class="sheet panel"><div class="survey-top"><div><span class="eyebrow">POST-TASK QUESTIONS</span><h2 style="margin-top:8px">${titles[surveyPage]}</h2></div><span class="pill">${surveyPage+1} / 3</span></div><p class="hint">${surveyPage===0?(fast()?'先按记忆回答。可以填写“不记得”“未介入”或“未到达该阶段”。核心问题完成后，可以查看本人的操作回放。':'先按记忆回答。任务资料暂不展示；不知道时可以直接说明。'):'按实际体验选择。1 = strongly disagree；7 = strongly agree。'}</p>${surveyPage?' <div class="scale-labels"><span>1 · 非常不同意</span><span>7 · 非常同意</span></div>':''}<form id="survey">${[recall,checks,experience][surveyPage]}<div class="actions">${surveyPage?'<button type="button" id="survey-back" data-tl="survey-back">← 上一部分</button>':''}<button type="submit" class="primary" data-tl="survey-submit">${surveyPage===2?(fast()?'保存核心回答并查看回放 →':'保存回答，进入访谈 →'):'保存，下一部分 →'}</button></div></form></section>`;const form=document.querySelector('#survey');if(fast())for(const control of form.querySelectorAll('textarea,input[type=text]'))control.maxLength=4000;for(const [key,value] of Object.entries(surveyAnswers)){const controls=form.querySelectorAll(`[name="${key}"]`);for(const el of controls)if(el.type==='radio')el.checked=el.value===value;else el.value=value;}
  const savePart=()=>{Object.assign(surveyAnswers,Object.fromEntries(new FormData(form)));trial.responses={...(trial.responses||{}),surveyDraft:surveyAnswers,revisionVisibilityApplicable:revised};persist();};
  form.onsubmit=e=>{e.preventDefault();savePart();trial.record('survey_part_complete',{part:surveyPage+1});
  // Preserve the first free response before showing structured checks. Back navigation
  // may revise the survey answer, but never rewrites this original observation.
  // Raw text stays only in the consented response, never in behavioural telemetry.
  if(surveyPage===0&&v2()&&!trial.responses.unpromptedRecall){trial.responses.unpromptedRecall={planAfterUpdate:surveyAnswers.planAfterUpdate,noticedChangeWhen:surveyAnswers.noticedChangeWhen,recordedBeforeChecks:true,clientMs:Math.round(performance.now()),streamId:telemetry.streamId,...(fast()?{currentSubgoal:surveyAnswers.currentSubgoal,predictedNext:surveyAnswers.predictedNext,diagnosis:surveyAnswers.diagnosis}:{})};}if(surveyPage<2){surveyPage++;surveyStep();}else{trial.responses={...(trial.responses||{}),survey:surveyAnswers,revisionVisibilityApplicable:revised};trial.record('survey_complete');persist();if(fast())sealCoreSurvey();else interview();}};document.querySelector('#survey-back')?.addEventListener('click',()=>{savePart();surveyPage--;surveyStep();});document.querySelector('#survey').addEventListener('input',()=>{Object.assign(surveyAnswers,Object.fromEntries(new FormData(document.querySelector('#survey'))));persist();});persist();window.scrollTo(0,0);focusHeading();}
async function loadTaskRecord(){
 app.innerHTML='<section class="sheet panel"><h2>正在准备你的任务记录…</h2><p role="status">记录准备好后即可参考作答。</p></section>';
 try{taskRecordLock=await api('task-record',trial.export());guidedSurveyStep();}
 catch{app.innerHTML='<section class="sheet panel"><h2>任务记录暂时未能加载</h2><p>你的操作和回答已保留，请重试。</p><button id="retry-record" class="primary">重新加载记录</button></section>';document.querySelector('#retry-record').onclick=loadTaskRecord;}
}
function guidedSurveyStep(){
 if(!taskRecordLock?.locked){loadTaskRecord();return;}
 const revised=design.planDynamics==='replanning';
 const order=`<label>资料更新后，agent 的工作顺序<select name="workOrderAfterUpdate" required><option value="">请选择</option><option value="venue-catering-form">场地 → 茶点 → 报名表</option><option value="form-venue-catering">报名表 → 场地 → 茶点</option><option value="other">其他顺序</option><option value="unsure">不确定</option><option value="not-reached">未观察到该阶段</option></select></label><label>你认为 agent 有没有改计划？<select name="recalledChange" required><option value="">请选择</option><option value="unchanged">保持原计划</option><option value="reordered">改变顺序</option><option value="unsure">不确定</option></select></label>`;
 const checks=order+firstChecks().map(x=>rating(...x)).join('')+(revised?rating('revisionWhen','I could identify when the plan was revised.')+rating('revisionWhat','I could identify which steps changed order.'):'')+`<label>正式权限核对<select name="authorityCheck" required><option value="">请选择</option><option value="all">我可以暂停、安排执行步骤并继续</option><option value="pause-only">我只能暂停</option><option value="unsure">不确定</option></select></label>`;
 app.innerHTML=`<section class="sheet panel"><div class="survey-top"><h2>${surveyPage===0?'计划与参与体验':'监督体验'}</h2><span class="pill">${surveyPage+1} / 2</span></div><p class="hint">你可以从本页开始参考任务记录。请按执行时的体验作答，不确定时如实选择。</p><div class="scale-labels"><span>1 · 非常不同意</span><span>7 · 非常同意</span></div><form id="survey">${surveyPage===0?checks:experienceChecks().map(x=>rating(...x)).join('')}<div class="actions">${surveyPage?'<button type="button" id="survey-back">← 上一部分</button>':''}<button type="submit" class="primary">${surveyPage?'保存回答，进入访谈 →':'保存，下一部分 →'}</button></div><p id="core-lock-feedback" class="feedback" role="status"></p></form></section>`;
 const form=document.querySelector('#survey');
 for(const [key,value] of Object.entries(surveyAnswers))for(const el of form.querySelectorAll(`[name="${key}"]`))if(el.type==='radio')el.checked=el.value===value;else el.value=value;
 const save=()=>{Object.assign(surveyAnswers,Object.fromEntries(new FormData(form)));trial.responses={...(trial.responses||{}),surveyDraft:surveyAnswers,revisionVisibilityApplicable:revised,recordAssistedCore:true,questionnaireMode:extended()?'record_assisted_workshop_v06':'record_assisted_v05'};persist();};
 form.oninput=save;form.onsubmit=e=>{e.preventDefault();save();trial.record('survey_part_complete',{part:surveyPage+1});if(!surveyPage){surveyPage=1;guidedSurveyStep();}else{trial.responses.survey={...surveyAnswers};trial.record('survey_complete');persist();sealCoreSurvey();}};
 document.querySelector('#survey-back')?.addEventListener('click',()=>{save();surveyPage=0;guidedSurveyStep();});attachReplay();persist();focusHeading();
}
const interviewQuestions=['请按自己的理解讲一下 agent 做了什么，哪些地方容易或难以理解？','决定介入或不介入时，你主要看了哪些信息？当时预期下一步是什么？','你有没有发现计划或顺序变化？何时、依据是什么？','资料更新后，你如何决定继续观察、查看信息或调整行动？','你认为场地先做和茶点先做有什么不同？有一种让 agent 显得更能干或更笨吗？',null,'如果没有纠正表单，当时发生了什么？先自由描述。','有没有觉得该介入却不知道怎么操作？哪些信息或控件最有帮助？','你觉得什么算 agent 做错了？与任务 brief 是否一致？','只改一个地方来帮助监督，你会改什么？'];
// q6 asks about the participant's own role in preparing the plan. In the core study
// nobody prepared it with the agent, so the question neutrally asks about reviewing the
// initial plan instead. The extension keeps the original co-planning wording verbatim.
const CO_PLANNING_Q6='最初准备计划的过程如何影响后续监督？哪些步骤或要求更容易记住？';
const REVIEW_ONLY_Q6='最初审阅初始计划的过程如何影响后续监督？哪些步骤或要求更容易记住？';
const interviewQuestion=i=>{
 if(v2()&&i===4)return '你认为先配置报名表和先安排场地、茶点有什么不同？这种顺序影响你对 agent 能力或任务难度的判断吗？';
 if(v2()&&i===6)return '你如何理解最终审查和发布之间的先后关系？如果没有恢复流程，当时发生了什么？先自由描述。';
 return i===5?(coPlanning()?CO_PLANNING_Q6:REVIEW_ONLY_Q6):interviewQuestions[i];
};
async function sealCoreSurvey(){
 const button=document.querySelector('#survey button[type=submit]');if(button)button.disabled=true;
 try{coreSurveyLock=await api('core-survey',trial.export());await interview();}
 catch{if(button)button.disabled=false;let note=document.querySelector('#core-lock-feedback');if(!note){note=document.createElement('p');note.id='core-lock-feedback';note.className='feedback';document.querySelector('#survey').append(note);}setText('core-lock-feedback','核心回答尚未保存成功。当前回答已保留，请再次点击提交重试。');}
}
const replayKindLabels={activity_preview:'Agent 正在处理细项',activity_completed:'Agent 已完成细项',preview:'Agent 开始动作预览',completed:'Agent 已执行步骤',service_update:'收到服务资料更新',paused:'你主动暂停',opened_editor:'你打开步骤安排',scheduled:'你应用了步骤安排（尚未执行）',resumed:'你继续执行',not_applied:'这次安排未应用',selected:'你选择了步骤',cancelled:'你关闭步骤安排',hidden:'页面离开，系统挂起',returned:'返回页面，等待确认',continued:'你确认返回任务',published:'Agent 已发布报名表',ended:'本次执行已结束'};
function renderReplay(filter='all'){
 const host=document.querySelector('#replay-events');if(!host||!replayReceipt()?.locked)return;
 const rows=replayReceipt().timeline.filter(row=>filter==='all'||row.category===filter);
 setHTML('replay-events',rows.map(row=>`<li><button type="button" class="replay-row" data-replay-index="${row.index}"><span class="small"><span>运行秒数</span> <b translate="no">${Math.round(row.activeMs/1000)}</b> · <span>实际秒数</span> <b translate="no">${Math.round(row.wallMs/1000)}</b></span><span>${esc(replayKindLabels[row.kind])}</span>${row.activityId?`<strong>${esc(activityById(row.activityId)?.title||'')}</strong><span class="hint">${esc(activityById(row.activityId)?.detail||'')}</span>`:''}${row.step&&row.kind!=='service_update'&&!row.activityId?`<strong>${esc(stepLabel(row.step))}</strong>`:''}</button></li>`).join(''));
 for(const button of host.querySelectorAll('[data-replay-index]'))button.onclick=()=>{trial.record('replay_item_view',{index:Number(button.dataset.replayIndex)});for(const row of host.querySelectorAll('button'))row.classList.toggle('selected',row===button);};
}
async function interview(){
 if(fast()){
  try{if(!coreSurveyLock?.locked)coreSurveyLock=await api('core-survey');if(!coreSurveyLock.locked){view('questionnaire','任务后回答');surveyPage=guided()?1:2;surveyStep();return;}trial.responses.survey=coreSurveyLock.survey;if(!guided())trial.responses.unpromptedRecall=coreSurveyLock.unpromptedRecall;if(guided()&&!taskRecordLock?.locked)taskRecordLock=await api('task-record');}
  catch{unavailable('暂时无法读取已保存的核心回答，请刷新后重试。');return;}
 }
 renderInterview();
}
function renderInterview(){view('interview','访谈记录');app.innerHTML=`<section class="sheet panel"><span class="eyebrow">YOUR EXPERIENCE</span><h2 style="margin-top:8px">分享你的想法</h2><p class="hint">${extended()?'以下 4 题均为可选，预计 1 分钟左右；可以留空直接提交。':'以下回答为可选内容。请描述你自己的体验；没有注意到或不确定也可以直接说。'}</p><form id="interview">${activeInterviewItems().map((id,index)=>`<label data-question-id="${id}">${index+1}. ${interviewQuestion(id-1)}<textarea name="q${id}"></textarea></label>`).join('')}<div class="actions"><button class="primary" type="submit" data-tl="interview-submit">提交回答 →</button></div></form></section>`;document.querySelector('#interview').onsubmit=e=>{e.preventDefault();trial.responses.interview=Object.fromEntries(new FormData(e.target));trial.record('interview_complete');persist();completed();};if(fast())attachReplay();focusHeading();}
function attachReplay(){
 const sheet=app.firstElementChild;sheet.classList.add('replay-questions');const grid=document.createElement('div');grid.className='post-task-layout';app.replaceChildren(grid);grid.append(sheet);
 const side=document.createElement('aside');side.className='panel replay-panel'+(guided()?' expanded':'');side.id='replay-panel';HLLI18n.bindHTML(side,`<div class="replay-heading"><h2>你的操作回放</h2><button type="button" class="replay-toggle" id="replay-toggle" aria-expanded="${guided()?'true':'false'}" aria-controls="replay-content">${guided()?'收起回放':'展开回放'}</button></div><div class="replay-content" id="replay-content"><p class="hint">${guided()?'参考实际记录回答；请区分当时注意到的信息和现在查看记录后才发现的信息。记录不提供对错评分。':'核心回答已保存。以下仅显示实际记录的动作与操作，不是建议顺序或对错评分。'}</p><label>查看记录<select id="replay-filter"><option value="all">全部记录</option><option value="agent">Agent 动作</option><option value="participant">我的干预</option><option value="result">执行结果</option><option value="system">系统挂起</option></select></label><ol id="replay-events" class="replay-events"></ol></div>`);grid.append(side);renderReplay();trial.record('replay_open');
 let exposureAt=null;const exposure=visible=>{if(visible&&exposureAt===null){exposureAt=performance.now();trial.record('replay_exposure',{visible:true,dwellMs:0});}else if(!visible&&exposureAt!==null){trial.record('replay_exposure',{visible:false,dwellMs:performance.now()-exposureAt});exposureAt=null;}};side.addEventListener('pointerenter',()=>exposure(!document.hidden));side.addEventListener('pointerleave',()=>exposure(false));document.addEventListener('visibilitychange',()=>{if(!['questionnaire','interview'].includes(stage)||document.hidden)exposure(false);});document.querySelector('#interview,#survey').addEventListener('submit',()=>exposure(false),{capture:true});
 document.querySelector('#replay-toggle').onclick=()=>{const open=side.classList.toggle('expanded');document.querySelector('#replay-toggle').setAttribute('aria-expanded',String(open));setText('replay-toggle',open?'收起回放':'展开回放');};
 document.querySelector('#replay-filter').onchange=e=>{trial.record('replay_filter',{filter:e.target.value});renderReplay(e.target.value);};
 const anchors=['可参考整个执行过程。','可以筛选“我的干预”，定位自己决定操作的片段。','可参考服务资料更新后的动作；请区分当时已注意到和现在看记录才想起。','可以结合更新后的动作与自己的操作回答。','可参考场地、茶点和报名表的实际执行先后。','这一题仍按你最初审阅计划时的体验回答；不记得也可以说明。','可参考发布前后实际发生的步骤。','可以筛选自己的步骤选择、应用、取消与继续操作。','请说出你自己的判断，不必寻找标准答案。','可以指出一个具体片段或控件。'];
 for(const [i,label] of sheet.querySelectorAll('#interview label').entries()){const hint=document.createElement('p');hint.className='hint question-anchor';HLLI18n.bindText(hint,anchors[Number(label.dataset.questionId||i+1)-1]);label.insertBefore(hint,label.querySelector('textarea'));}
 persist();
}
function thankYou(receipt){view('done','已完成');app.innerHTML=`<section class="sheet panel"><span class="eyebrow">SESSION COMPLETE</span><h2 style="margin-top:8px">感谢你的参与</h2><p>你的回答已经收到。本次测试已完成，可以关闭页面。</p><p class="small">提交编号：${esc(receipt)}</p><p class="hint">如有后续问题，请联系向你发送邀请码的研究者。</p></section>`;}
async function completed(){view('done','提交回答');persist();app.innerHTML='<section class="sheet panel"><h2>正在提交你的回答…</h2><p>请暂时保持页面打开。</p></section>';try{const result=await api('submit',await withTelemetry(trial.export()));localStorage.removeItem('is6912-online-progress');thankYou(result.receipt);}catch{app.innerHTML='<section class="sheet panel"><h2>回答尚未提交成功</h2><p>当前设备已保留记录，请检查网络后重试。</p><button id="retry-submit" class="primary" data-tl="retry-submit">重新提交</button></section>';document.querySelector('#retry-submit').onclick=completed;}}
// Best effort, bounded telemetry flush before submitting. A telemetry failure never
// blocks completion: the collection counters travel with the result so a partial or
// missing record is visible in analysis instead of looking like a complete one.
async function withTelemetry(report){let info=null;try{telemetry.summary();info=await telemetry.flushFinal(4000);}catch{}report.telemetry={version:telemetry.version,localeInitial:HLLI18n.getInitialLanguage(),locale:HLLI18n.getLanguage(),languageContext:languageContext??null,...(info||telemetry.info())};telemetry.transition();return report;}
function persist(){if(trial)try{localStorage.setItem('is6912-online-progress',JSON.stringify({id:trial.id,state:trial,stage,surveyAnswers,surveyPage,uiVersion:UI_VERSION}));}catch{if(!trial.protocolFlags.includes('storage_unavailable'))trial.protocolFlags.push('storage_unavailable');}}
document.querySelector('#visibility-continue').onclick=confirmVisibilityReturn;
document.querySelector('#visibility-stay').onclick=()=>{document.querySelector('#visibility-return').close();document.querySelector('#held-return-control').hidden=false;};
document.querySelector('#held-return-control').onclick=()=>{document.querySelector('#held-return-control').hidden=true;showVisibilityReturn();};
document.querySelector('#visibility-return').addEventListener('cancel',e=>e.preventDefault());
document.addEventListener('visibilitychange',()=>{if(fast()&&stage==='execution'&&!trial.ended){if(document.hidden)holdForVisibility();else showVisibilityReturn();return;}if(document.hidden&&stage==='execution'&&!trial.ended){trial.protocolFlags.push('page_hidden');trial.finish('technical_interruption');clearInterval(timer);questionnaire();}});
// Language is a participant preference, not a factor: it is recorded as an observed
// covariate and never pauses, restarts or otherwise changes the trial.
document.addEventListener('hll:languagechange',event=>{telemetry.languageChange(event.detail.from,event.detail.to);const current=document.getElementById('formal-language');if(current)current.textContent=event.detail.to==='en'?'English':'中文';});
window.addEventListener('beforeunload',e=>{if(stage==='execution'&&!trial.ended){persist();e.preventDefault();e.returnValue='';}});
setup();
