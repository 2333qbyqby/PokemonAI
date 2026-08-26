import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function writeStatus(file: string, state: string, message = ''): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify({state, updatedAt: new Date().toISOString(), message}, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
