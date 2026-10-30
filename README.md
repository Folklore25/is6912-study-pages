# Human Loop Lab participant assets

Public participant files for the controlled IS6912 pilot. Participants enter through https://study.humanlooplab.xyz/; qualification, records and administration are handled by separate protected services.

Protocol v2 (`2026-10-19-plan-dependent-v03`) uses a scripted simulated workflow, four conditions and a mandatory review-recovery event. English is the default; participants choose English or Chinese before enrollment and keep that language for the session. No live model or provider credential belongs in these assets.

The private study-platform repository is the source of truth. This repository contains no administrator interface, server configuration, invitation secrets or research records.

The current participant implementation uses a faster fixed execution schedule, independent holds when the page is hidden, explicit return confirmation, and core answers saved before an optional public action replay. Implementation policy is frozen per invitation/session; the four-condition study design is unchanged.
