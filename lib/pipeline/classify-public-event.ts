import type {
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
  Materiality,
} from "@/lib/market-types";
import type { SourceKind } from "@/lib/pipeline/contracts";

export interface PublicEventClassification {
  category: IntelligenceEvent["category"];
  materiality: Materiality;
  claimStatus: ClaimStatus;
  causalLink: CausalLink;
  topicTags: string[];
  isControversial: boolean;
}

const matches = (text: string, pattern: RegExp) => pattern.test(text);

export function classifyPublicEvent({
  headline,
  summary,
  sourceKind,
}: {
  headline: string;
  summary?: string | null;
  sourceKind: SourceKind;
}): PublicEventClassification {
  const text = `${headline} ${summary ?? ""}`.toLowerCase();
  const hasExecutive = matches(
    text,
    /\b(ceo|chief executive|founder|chair|executive|management|succession)\b/,
  );
  const hasGovernanceRisk = matches(
    text,
    /\b(board|governance|resign|resignation|oust|remove|internal investigation|independent investigation|probe)\b/,
  );
  const hasLegalRisk = matches(
    text,
    /\b(lawsuit|litigation|indict|criminal|civil complaint|class action|court|subpoena)\b/,
  );
  const hasRegulatoryRisk = matches(
    text,
    /\b(regulator|regulatory|sec investigation|ftc|doj|antitrust|enforcement|compliance)\b/,
  );
  const hasGeopoliticalRisk = matches(
    text,
    /\b(export control|sanction|national security|foreign intelligence|china|taiwan|geopolitical)\b/,
  );
  const hasReputationRisk = matches(
    text,
    /\b(scandal|controversy|backlash|boycott|affair|misconduct|ethics|harassment|discrimination|allegation)\b/,
  );

  let category: IntelligenceEvent["category"] =
    sourceKind === "sec_filing" ? "filing" : "market";
  if (hasLegalRisk) category = "legal";
  else if (hasRegulatoryRisk) category = "regulatory";
  else if (hasExecutive && hasGovernanceRisk) category = "governance";
  else if (hasExecutive && hasReputationRisk) category = "executive";
  else if (hasGeopoliticalRisk) category = "geopolitical";
  else if (hasReputationRisk) category = "reputation";

  let claimStatus: ClaimStatus = sourceKind === "sec_filing" ? "confirmed" : "reported";
  if (matches(text, /\b(corrected|correction|retracted|retraction)\b/)) {
    claimStatus = "corrected";
  } else if (matches(text, /\b(denied|denies|disputed|disputes|refuted)\b/)) {
    claimStatus = "disputed";
  } else if (
    matches(
      text,
      /\b(independent investigation|internal investigation|opened an investigation|launches investigation|board investigation)\b/,
    )
  ) {
    claimStatus = "official-investigation";
  } else if (matches(text, /\b(alleged|allegation|accused|accusation)\b/)) {
    claimStatus = "allegation";
  }

  const topicTags = [
    hasExecutive ? "executive" : null,
    hasGovernanceRisk ? "governance" : null,
    hasLegalRisk ? "legal" : null,
    hasRegulatoryRisk ? "regulatory" : null,
    hasGeopoliticalRisk ? "geopolitical" : null,
    hasReputationRisk ? "reputation" : null,
  ].filter((value): value is string => value !== null);

  const highImpact =
    hasLegalRisk ||
    hasRegulatoryRisk ||
    hasGeopoliticalRisk ||
    (hasExecutive && hasGovernanceRisk);

  return {
    category,
    materiality: highImpact ? "high" : hasReputationRisk ? "medium" : "medium",
    claimStatus,
    causalLink: "unassessed",
    topicTags,
    isControversial:
      hasReputationRisk || hasLegalRisk || hasRegulatoryRisk || hasGovernanceRisk,
  };
}
