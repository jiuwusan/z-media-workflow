import { randomBytes } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../util/error.js';
export function writeRecoveryPasskey(directory, passkey) {
      const temporary=path.join(directory,`.passkey-${randomBytes(16).toString('hex')}`);
      let fd;
      try {
        fd=openSync(temporary,'wx',0o600);writeFileSync(fd,passkey+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
        renameSync(temporary,path.join(directory,'passkey'));
      } catch {
        throw new AppError('passkey 保存失败，请检查数据目录权限',500);
      } finally {
        if(fd!==undefined)closeSync(fd);
        try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
}
