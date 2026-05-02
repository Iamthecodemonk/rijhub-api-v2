export default async function docsGuard(request, reply) {
  const isProd = process.env.NODE_ENV === 'production';
  // In production hide the docs entirely
  if (isProd) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }

  // If a token is configured, require it via header or query
  const token = request.headers['x-docs-token'] || request.query?.token;
  if (process.env.SWAGGER_DOCS_TOKEN) {
    if (!token || token !== process.env.SWAGGER_DOCS_TOKEN) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  }

  // If basic auth credentials are configured, require Basic auth
  const user = process.env.SWAGGER_USER;
  const pass = process.env.SWAGGER_PASS;
  if (user && pass) {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="Docs"').code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const creds = Buffer.from(auth.slice(6), 'base64').toString();
      const [u, p] = creds.split(':');
      if (u !== user || p !== pass) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
    } catch (e) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  }

  // otherwise allow through
}
