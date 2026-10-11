/* Deterministic trial engine. No network, model calls, or participant UI. */
(function (root) {
  'use strict';
  const VERSION = '2026-10-11-online-v01';
  const CELLS = ['S-H-C','S-H-O','S-L-C','S-L-O','R-H-C','R-H-O','R-L-C','R-L-O'];
  const FIELDS = ['name','email','diet'];
  const NAMES = {name:'姓名', email:'邮箱', diet:'饮食偏好', hkid:'HKID'};
  const P0 = ['brief','venue','catering','form','email','publish'];
  const LABELS = {brief:'核对目标和约束',venue:'选择场地 A',catering:'选择 Basic 茶点',form:'配置报名表（姓名、邮箱、饮食偏好）',email:'生成并检查邀请邮件',publish:'发布报名表，再发送邀请邮件'};
  const clone = x => JSON.parse(JSON.stringify(x));
  const safeFields = fields => fields.length===3 && FIELDS.every(x=>fields.includes(x));
  class Trial {
    constructor(cell, participantId, pace=1) {
      if (!CELLS.includes(cell)) throw new Error('Invalid cell');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(participantId)) throw new Error('Use an anonymous ID');
      if (![1,0.1].includes(pace)) throw new Error('Invalid pace');
      this.cell=cell; this.id=participantId; this.pace=pace;
      this.activeMs=0; this.wallMs=0; this.phaseMs=0; this.pauseMs=0;
      this.phase='ready'; this.paused=false; this.editorOpen=false; this.ended=false;
      this.plan=[...P0]; this.completed=[]; this.trace=[]; this.events=[];
      this.payload={venue:'A',catering:'Basic',fields:[...FIELDS]};
      this.published=null; this.emailSent=false; this.e2Start=null; this.e2End=null;
      this.firstE2Intervention=null; this.firstE2Correction=null; this.protocolFlags=[];
      this.revision=''; this.responses=null; this.preparation=null;
      this.record('configured',{cell,pace,scriptVersion:VERSION});
    }
    record(type,data={}) {this.events.push({type,phase:this.phase,activeMs:this.activeMs,wallMs:this.wallMs,data:clone(data)});}
    duration() {return ({brief:20000,event:30000,resource:30000,form:30000,email:30000,publish:30000,send:10000})[this.phase]*this.pace;}
    currentId() {return this.phase==='resource'?this.plan.find(x=>['venue','catering'].includes(x)&&!this.completed.includes(x)):({brief:'brief',form:'form',email:'email',publish:'publish',send:'publish',event:null})[this.phase];}
    enter(phase) {
      this.phase=phase; this.phaseMs=0;
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
    start(preparation) {if(this.phase!=='ready')throw new Error('Already started');this.preparation=clone(preparation);if(this.modelBundle?.initial)this.plan=[...this.modelBundle.initial];this.record('initial_plan',{plan:P0,preparation});this.enter('brief');}
    next() {
      if(this.ended||this.paused)return;
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
    tick(ms) {
      if(!Number.isFinite(ms)||ms<0)throw new Error('Invalid elapsed time');
      if(this.ended||this.phase==='ready')return;
      this.wallMs+=ms;
      if(this.paused){this.pauseMs+=ms;if(this.pauseMs>=60000*this.pace){this.record('pause_limit');this.finish('pause_limit');}return;}
      // A long/background tick cannot silently skip a preview: mark it and end.
      if(ms>5000*this.pace){this.protocolFlags.push('long_frame_gap');this.finish('technical_interruption');return;}
      this.activeMs+=ms;this.phaseMs+=ms;
      if(this.phaseMs>=this.duration())this.next();
    }
    intervention(kind){if(this.phase==='publish'&&this.firstE2Intervention===null)this.firstE2Intervention=this.activeMs-this.e2Start;this.record(kind);}
    pause(kind='pause'){
      if(this.ended||this.paused||this.phase==='ready')return;
      this.intervention(kind);this.paused=true;this.pauseMs=0;
    }
    resume(){if(this.ended||!this.paused||this.editorOpen)return;this.record('resume');this.paused=false;this.pauseMs=0;}
    edit(changes){
      if(this.ended||!this.paused)throw new Error('Pause before editing');
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
    redirect(){if(this.ended)return;this.pause('redirect');this.edit({fields:[...FIELDS]});this.record('safe_template_redirect');}
    stop(){if(this.ended)return;this.intervention('stop');this.finish('stopped');}
    finish(reason){if(this.ended)return;this.ended=true;this.reason=reason;this.editorOpen=false;this.record('trial_end',{reason,metrics:this.metrics()});}
    metrics(){
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
    export(){return clone({schemaVersion:1,scriptVersion:VERSION,participantId:this.id,cell:this.cell,pace:this.pace,createdAt:new Date().toISOString(),preparation:this.preparation,initialPlan:P0,finalPlan:this.plan,finalPayload:this.payload,firstPublishedPayload:this.published,reason:this.reason,protocolFlags:this.protocolFlags,metrics:this.metrics(),events:this.events,responses:this.responses});}
  }
  const API={Trial,CELLS,P0,LABELS,FIELDS,NAMES,VERSION,safeFields};
  if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.Oversight=API;
})(typeof window!=='undefined'?window:globalThis);
