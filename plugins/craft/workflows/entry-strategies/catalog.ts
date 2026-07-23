export const CRAFT_ENTRY_STRATEGIES = Object.freeze({
  "problem-description": "ys_craft_start_problem",
  "root-cause-import": "ys_craft_review_blueprint",
} as const);

export type CraftEntryStrategy = keyof typeof CRAFT_ENTRY_STRATEGIES;
