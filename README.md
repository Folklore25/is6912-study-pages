# Human Loop Lab participant assets

Public participant files for the controlled IS6912 pilot. Participants enter through https://study.humanlooplab.xyz/; qualification, records and administration are handled by separate protected services.

Protocol v2 (`2026-10-19-plan-dependent-v03`) uses a scripted simulated workflow, four conditions and a mandatory review-recovery event. English is the default; participants choose English or Chinese before enrollment and keep that language for the session. No live model or provider credential belongs in these assets.

The private study-platform repository is the source of truth. This repository contains no administrator interface, server configuration, invitation secrets or research records.

The current implementation retains the faster fixed execution schedule, hidden-page holds and explicit return confirmation. After pilot usability feedback, initial-plan reading has a five-second visible minimum and the public task record is available from the first questionnaire page; unaided free recall is removed. Execution is frozen server-side before reference exposure, and assisted answers are marked separately. Existing sessions retain their frozen implementation policy.
