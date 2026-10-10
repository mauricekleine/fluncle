import { type LabelAdminItem } from "@fluncle/contracts";

type LabelFact = {
  kind: "disambiguation" | "founded" | "location";
  text: string;
};

export function buildLabelFacts(
  label: Pick<LabelAdminItem, "disambiguation" | "foundedLocation" | "foundingDate">,
) {
  const foundingYear = label.foundingDate?.slice(0, 4);
  const facts: { kind: LabelFact["kind"]; text: string | null | undefined }[] = [
    { kind: "disambiguation", text: label.disambiguation },
    {
      kind: "founded",
      text: foundingYear ? `Founded ${foundingYear}` : undefined,
    },
    { kind: "location", text: label.foundedLocation },
  ];

  return facts.filter(
    (fact): fact is LabelFact => typeof fact.text === "string" && fact.text.trim().length > 0,
  );
}
