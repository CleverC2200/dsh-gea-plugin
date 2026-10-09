import {statFile} from '@electron/asar';
export function archiveEntry(path){
  const match=/^(.*[\\/]node_modules\.asar)[\\/](.+)$/.exec(path);
  if(!match)return null;
  return {archive:match[1],relative:match[2],entry:statFile(match[1],match[2].replaceAll('\\','/'))};
}
