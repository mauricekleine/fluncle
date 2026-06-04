import { getAntipattern } from "./registry/antipatterns.mjs";

function getAP(id) {
  return getAntipattern(id);
}

function finding(id, filePath, snippet, line = 0) {
  const ap = getAP(id);
  return {
    antipattern: id,
    description: ap.description,
    file: filePath,
    line,
    name: ap.name,
    severity: ap.severity || "warning",
    snippet,
  };
}

export { getAP, finding };
