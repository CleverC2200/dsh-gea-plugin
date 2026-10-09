const AUTH_COOKIE_PREFIX = 'dsh-auth-';

async function clearRuntimeCookies(cookieStore, hosts = ['127.0.0.1', 'localhost']) {
  for (const host of hosts) {
    const url = `http://${host}/`;
    const cookies = await cookieStore.get({url});
    for (const cookie of cookies) {
      if (typeof cookie.name === 'string' && cookie.name.startsWith(AUTH_COOKIE_PREFIX)) {
        await cookieStore.remove(url, cookie.name);
      }
    }
  }
}

module.exports = {AUTH_COOKIE_PREFIX, clearRuntimeCookies};
