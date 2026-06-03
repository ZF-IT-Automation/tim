/** Project entry metadata (kind=project). */
export interface ProjectMetadata {
  kind: 'project';
  label: string;
  aliases?: string[];
  [key: string]: unknown;
}

export type ResolveProjectResult =
  | { status: 'found'; label: string }
  | { status: 'not_found'; query: string }
  | { status: 'ambiguous'; query: string; labels: string[] };
