
const cookies: any = {};
export function setCookies(headers) {
  if (!headers['set-cookie']) return cookies;

  for (const cookiepies of headers['set-cookie']) {
    let cookieName: string | undefined = undefined;
    const cookiepie = cookiepies.split(';');
    for (const cookie of cookiepie) {
      const [key, val] = cookie.split('=');
      if (!cookieName) {
        cookieName = key.trim();
        cookies[cookieName!] = {
          value: val ?? true
        };
      } else {
        cookies[cookieName][key.trim()] = val ?? true;
      }
    }
  }
  return cookies;
}

export function getCookieValue(...cookieNames: string[]) {
  let ret = '';
  for (const cookieName of cookieNames) {
    if (cookies[cookieName])
      ret += `${cookieName}=${cookies[cookieName].value}; `;
  }
  return ret;
}
