import { handleApi } from '../lib/core.mjs';
export default async (req) => handleApi(req);
export const config = { path: '/api/*' };
