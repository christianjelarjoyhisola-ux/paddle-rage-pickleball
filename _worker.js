export default {
  fetch(request, env) {
    const url = new URL(request.url);

    const primaryHostname = String(env.PRIMARY_HOSTNAME || '').trim().toLowerCase();
    if (primaryHostname && url.hostname === `www.${primaryHostname}`) {
      url.hostname = primaryHostname;
      return Response.redirect(url.toString(), 301);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    return env.ASSETS.fetch(request);
  },
};
