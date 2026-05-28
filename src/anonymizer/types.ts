export type EntityType =
  | "PERSON"
  | "ORG"
  | "LOC"
  | "EMAIL"
  | "PHONE"
  | "IBAN"
  | "CREDIT_CARD"
  | "IP"
  | "URL"
  | "PATH"
  | "UUID"
  | "API_KEY"
  | "SSN"
  | "DATE";

export interface Entity {
  start: number;
  end: number;
  type: EntityType;
  text: string;
  /** Confidence in [0, 1]. Regex matches use 1. */
  score: number;
  /** Source detector, useful for debugging/UI. */
  source: "regex" | "ner";
}

export interface AnonymizationResult {
  /** Text safe to send to the cloud LLM. */
  anonymized: string;
  /** Entities found in the original text, sorted by start. */
  entities: Entity[];
  /** Placeholder → original value, used for de-anonymization of the response. */
  reverseMap: Map<string, string>;
}
