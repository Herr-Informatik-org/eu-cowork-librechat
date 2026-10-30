import { visit } from 'unist-util-visit';
import type { Root } from 'hast';
import type { TAttachment, TFile } from 'librechat-data-provider';

/** Preserve sandbox references as inert controls, never as a browser URL scheme. */
export function rehypeGeneratedFileLinks() {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      const href = node.properties?.href;
      if (node.tagName !== 'a' || typeof href !== 'string' || !/^sandbox:/i.test(href)) return;
      node.tagName = 'generated-file-link';
      node.properties = { 'data-sandbox-path': href };
    });
  };
}

function relativeSandboxPath(value: string): string | undefined {
  if (!value.startsWith('sandbox:/mnt/data/') || value.length > 2048) return;
  try {
    const path = decodeURIComponent(value.slice('sandbox:/mnt/data/'.length));
    // Reject ambiguous encodings, traversal, query strings and URL fragments.
    // eslint-disable-next-line no-control-regex
    if (!path || /[\\%?#\u0000-\u001f\u007f]/.test(path)) return;
    if (path.split('/').some((part) => !part || part === '.' || part === '..')) return;
    return path;
  } catch {
    return;
  }
}

/** Match the complete stored relative path in this message, never a basename or global file list. */
export function resolveGeneratedFile(
  path: string,
  attachments: readonly TAttachment[] = [],
): Pick<TFile, 'file_id' | 'filename' | 'filepath' | 'source' | 'user'> | undefined {
  const relative = relativeSandboxPath(path);
  const sandbox = /^sandbox:/i.test(path);
  if (!path || (sandbox && !relative)) return;
  const matches = attachments.filter((file) =>
    sandbox ? file.filename === relative : file.filepath === path,
  );
  if (!matches.length) return;
  const ids = new Set<string>();
  for (const file of matches) {
    const id = (file as Partial<TFile>).file_id;
    // A legacy attachment without a stored ID can also make this path ambiguous.
    if (typeof id !== 'string' || !id) return;
    ids.add(id);
  }
  if (ids.size !== 1) return;
  const filename = matches[0].filename;
  if (!filename || matches.some((file) => file.filename !== filename)) return;
  const { filepath, source, user } = matches[0] as TFile;
  // Duplicate lifecycle records must agree on the download destination as well.
  if (
    matches.some(
      (file) =>
        file.filepath !== filepath ||
        (file as Partial<TFile>).source !== source ||
        (file as Partial<TFile>).user !== user,
    )
  )
    return;
  return { file_id: [...ids][0], filename, filepath, source, user };
}

export function isRegisteredFileLink(
  href: string,
  attachments: readonly TAttachment[] = [],
): boolean {
  return !!href && attachments.some((file) => file.filepath === href);
}
