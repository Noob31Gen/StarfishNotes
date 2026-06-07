import type { VaultFile } from '../services/github';

export interface TreeFolder {
  type: 'folder';
  name: string;
  path: string;
  children: (TreeFolder | TreeFile)[];
}

export interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  file: VaultFile;
}

export function buildFolderTree(files: VaultFile[]): (TreeFolder | TreeFile)[] {
  const root: (TreeFolder | TreeFile)[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let currentChildren = root;
    let currentPath = '';

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let folder = currentChildren.find(
        c => c.type === 'folder' && c.name === part
      ) as TreeFolder;

      if (!folder) {
        folder = {
          type: 'folder',
          name: part,
          path: currentPath,
          children: []
        };
        currentChildren.push(folder);
      }

      currentChildren = folder.children;
    }

    if (file.name !== '.gitkeep') {
      currentChildren.push({
        type: 'file',
        name: file.name,
        path: file.path,
        file
      });
    }
  }

  const sortNode = (a: TreeFolder | TreeFile, b: TreeFolder | TreeFile): number => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  };

  const recursiveSort = (nodes: (TreeFolder | TreeFile)[]) => {
    nodes.sort(sortNode);
    for (const node of nodes) {
      if (node.type === 'folder') {
        recursiveSort(node.children);
      }
    }
  };

  recursiveSort(root);
  return root;
}
