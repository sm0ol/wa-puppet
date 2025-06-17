import fastify from '../index.js';

export default async function handler(req, res) {
  await fastify.ready();
  return fastify.server.emit('request', req, res);
}