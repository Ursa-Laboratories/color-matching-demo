import { createHandler } from '../../../live/http.js';

export const config = { api: { bodyParser: false } };
export { createHandler };
export default createHandler();
