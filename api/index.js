// Vercel Function: the CRM backend. Built code lives in apps/api/dist (see vercel.json).
module.exports = async (req, res) => {
  const { handler } = await import('../apps/api/dist/vercel.js');
  return handler(req, res);
};
