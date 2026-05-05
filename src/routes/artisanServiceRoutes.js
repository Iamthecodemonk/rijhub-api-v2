import { createOrUpdateServices, listMyServices, getService, updateService, deleteService, getPriceSuggestion } from '../controllers/artisanServiceController.js';
import { verifyJWT } from '../middlewares/auth.js';
import { requireRole } from '../middlewares/roles.js';

export default async function (fastify, opts) {
  const createSchema = {
    body: {
      type: 'object',
      required: ['categoryId', 'services'],
      properties: {
        categoryId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
        services: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subCategoryId', 'price'],
            properties: {
              subCategoryId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
              price: { type: 'number', minimum: 0 },
              currency: { type: 'string' },
              notes: { type: 'string' }
            }
          }
        }
      }
    }
  };

  const updateSchema = {
    body: {
      type: 'object',
      properties: {
        services: { type: 'array' },
        isActive: { type: 'boolean' }
      }
    }
  };
  // Public: list offerings for a given artisan (by artisanId or artisan doc id)
  fastify.get('/artisan/:artisanId', async (request, reply) => {
    const { listByArtisan } = await import('../controllers/artisanServiceController.js');
    return listByArtisan(request, reply);
  });

  // Artisan-only endpoints to manage their offered services
  fastify.post('/', { preHandler: [verifyJWT, requireRole('artisan')], schema: createSchema }, createOrUpdateServices);
  fastify.get('/me', { preHandler: [verifyJWT, requireRole('artisan')] }, listMyServices);
  fastify.get('/price-suggestion', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          categoryId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
          subCategoryId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
        },
        anyOf: [
          { required: ['categoryId'] },
          { required: ['subCategoryId'] },
        ],
      },
    },
  }, getPriceSuggestion);
  fastify.get('/:id', { preHandler: [verifyJWT, requireRole('artisan')] }, getService);
  fastify.put('/:id', { preHandler: [verifyJWT, requireRole('artisan')], schema: updateSchema }, updateService);
  fastify.delete('/:id', { preHandler: [verifyJWT, requireRole('artisan')] }, deleteService);
}
