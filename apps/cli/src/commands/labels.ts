import { type LabelGetResponse, type LabelsResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";
import { entityDetailLines, printEntityIndex } from "./entity-browse";

export async function labelsCommand({
  json,
  page,
  slug,
}: {
  json: boolean;
  page: number;
  slug: string | undefined;
}): Promise<void> {
  if (slug) {
    const response = await publicApiGet<LabelGetResponse>(
      `/api/v1/labels/${encodeURIComponent(slug)}`,
    );

    if (json) {
      printJson(response);
      return;
    }

    const { label } = response;
    const lines = entityDetailLines(label.name, label.slug, label.trackCount, label.findingCount);

    if (label.foundedLocation) {
      lines.push(`Based: ${label.foundedLocation}`);
    }

    if (label.parentLabel) {
      lines.push(`Imprint of: ${label.parentLabel.name}`);
    }

    console.log(lines.join("\n"));
    return;
  }

  const response = await publicApiGet<LabelsResponse>(`/api/v1/labels?page=${page}`);

  if (json) {
    printJson(response);
    return;
  }

  printEntityIndex(response.labels, response, { plural: "labels", singular: "label" }, "labels");
}
