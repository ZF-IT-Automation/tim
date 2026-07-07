export const TIM_HANDOFF_SKILL = {
  name: 'tim-handoff',
  description:
    'Prep for /clear: checkpoint with handoff note and update Next Steps before clearing context.',
  content: `Before /clear:
1. Git-clean gate on repos you touched.
2. tim_checkpoint with handoff_note (done | wip | next).
3. tim_update project Next Steps (read → merge → update).
4. Tell user to /clear after checkpoint OK.`,
};
