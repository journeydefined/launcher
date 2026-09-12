import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { client, publish, saveInvitation } from './owner-client.mjs';
const [command, ...args] = process.argv.slice(2);
const options = {};
for(let i=0;i<args.length;i++) { if(!args[i].startsWith('--'))throw new Error('Use named --options.'); options[args[i].slice(2)] = args[i+1] && !args[i+1].startsWith('--') ? args[++i] : true; }
const required = name => { if(typeof options[name] !== 'string' || !options[name])throw new Error(`Missing --${name}.`); return options[name]; };
try {
  if(command === 'init') {
    const path = resolve(required('key-file')); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, randomBytes(32).toString('base64url'), { flag:'wx', mode:0o600 });
    console.log('Owner key generated in the specified private file. Keep it off Git and share it only with the service administrator.');
  } else {
    const api = client({ url: required('url'), key: (await readFile(required('key-file'),'utf8')).trim() });
    if(command === 'bootstrap') console.log(JSON.stringify(await api('POST','/admin/bootstrap')));
    else if(command === 'invite') {
      const out = required('out'); const invitation = await api('POST','/admin/testers',{ name:required('name'), days:Number(options.days ?? 30) });
      try { await saveInvitation(out,invitation); } catch(error) { await api('DELETE',`/admin/testers/${invitation.testerId}`); throw error; }
      console.log(`Invitation saved to ${resolve(out)}. Expires ${new Date(invitation.expires).toISOString()}. Transfer this file privately; it grants game access.`);
    } else if(command === 'testers') console.log(JSON.stringify(await api('GET','/admin/testers'),null,2));
    else if(command === 'revoke') console.log(JSON.stringify(await api('DELETE',`/admin/testers/${required('id')}`)));
    else if(command === 'releases') console.log(JSON.stringify(await api('GET','/admin/releases'),null,2));
    else if(command === 'uploads') console.log(JSON.stringify(await api('GET','/admin/uploads'),null,2));
    else if(command === 'discard-upload') console.log(JSON.stringify(await api('DELETE',`/admin/uploads/${required('id')}`)));
    else if(command === 'activate') console.log(JSON.stringify(await api('PUT','/admin/channel',{version:required('version')})));
    else if(command === 'audit') console.log(JSON.stringify(await api('GET','/admin/audit'),null,2));
    else if(command === 'publish') {
      let last = -1;
      const result=await publish({api,manifestPath:resolve(required('manifest')),activate:options.activate===true,onVerification:(done,total)=>{console.log(`Verifying ${Math.floor(done*100/total)}%`);},onProgress:(done,total)=>{const percent=Math.floor(done*100/total);if(percent!==last){console.log(`Uploaded ${percent}%`);last=percent;}}});
      console.log(JSON.stringify(result));
    } else throw new Error('Commands: init, bootstrap, invite, testers, revoke, publish, releases, activate, uploads, discard-upload, audit. See service/README.md.');
  }
} catch(error) { console.error(error.message); process.exitCode=1; }
