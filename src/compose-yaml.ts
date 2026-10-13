import { isMap, isSeq, parseDocument, type Document } from "yaml";

export function parseComposeDocument(yaml: string): Document {
  const doc = parseDocument(yaml, { merge: true, prettyErrors: false, logLevel: "silent" });
  const error = doc.errors[0] ?? doc.warnings[0];
  if (error) throw new Error(`compose is not valid YAML (${error.code})`);
  try {
    // bound alias expansion and reject cycles without exposing source excerpts.
    JSON.stringify(doc.toJS({ maxAliasCount: 100 }));
  } catch {
    throw new Error("compose contains invalid, cyclic, or excessive YAML aliases");
  }
  return doc;
}

export function walkYaml(node: unknown, visit: (node: unknown, key: boolean) => void, key = false): void {
  visit(node, key);
  if (isMap(node)) {
    for (const pair of node.items) {
      walkYaml(pair.key, visit, true);
      walkYaml(pair.value, visit);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) walkYaml(item, visit);
  }
}
