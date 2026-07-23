import type { YuanshengRootCauseBlueprintV1Lite } from "./generated/types/yuansheng-root-cause-blueprint-v1-lite";

export interface SemanticIssue {
  readonly code: string;
  readonly instancePath: string;
  readonly message: string;
}

function issue(code: string, instancePath: string, message: string): SemanticIssue {
  return { code, instancePath, message };
}

export function checkYuanshengRootCauseBlueprintV1Lite(
  blueprint: YuanshengRootCauseBlueprintV1Lite,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const recommended = blueprint.section2_summary.recommend_to_ys_craft;
  const proceeding = blueprint.section6_ys_craft_actions.proceed_to_optimization;

  if (recommended !== proceeding) {
    issues.push(
      issue(
        "ys-craft-decision-conflict",
        "/section6_ys_craft_actions/proceed_to_optimization",
        "Yuansheng Craft recommendation and optimization decision must agree in v1-lite",
      ),
    );
  }

  const gaps = new Set(blueprint.section5_risks_and_gaps.current_gaps);
  if (!gaps.has("source_location_unavailable")) {
    return issues;
  }

  const priorityLocation = blueprint.section6_ys_craft_actions.priority_location;
  const hotspotFunctions = new Set(
    blueprint.section3_key_evidence["3_2_hotspot_evidence"].map(
      (hotspot) => hotspot.hotspot_function,
    ),
  );
  if (priorityLocation !== null && !hotspotFunctions.has(priorityLocation)) {
    issues.push(
      issue(
        "unsupported-priority-location",
        "/section6_ys_craft_actions/priority_location",
        "Without source-location evidence, priority_location may only name an evidenced hotspot function",
      ),
    );
  }

  const action = blueprint.section6_ys_craft_actions.recommended_first_action;
  const sourcePathOrLine =
    /(?:^|[\s('"`])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?::[0-9]+)?(?:$|[\s,.;)'"`])/u;
  const explicitLine = /(?:\bline\s*[0-9]+\b|\u7b2c\s*[0-9]+\s*\u884c)/iu;
  if (sourcePathOrLine.test(action) || explicitLine.test(action)) {
    issues.push(
      issue(
        "unsupported-action-location",
        "/section6_ys_craft_actions/recommended_first_action",
        "recommended_first_action must not invent a source path or line while source evidence is unavailable",
      ),
    );
  }

  return issues;
}
