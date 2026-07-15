import { Atom } from "effect/unstable/reactivity";

export type UploadedFileMeta = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Stores the list of files successfully uploaded and confirmed for a session.
 * Keyed by sessionId. keepAlive so the confirm page reads it after navigation.
 */
export const sessionFilesAtomFamily = Atom.family((_sessionId: string) =>
  Atom.make<UploadedFileMeta[]>([]).pipe(Atom.keepAlive),
);
