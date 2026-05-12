const router = require('express').Router();
const ctrl   = require('../controllers/productAddon');
const { verifyToken } = require('../middleware/auth');

router.get   ('/products/:productId/addons',        verifyToken, ctrl.getAddons);
router.post  ('/products/:productId/addons',        verifyToken, ctrl.createAddon);
router.delete('/products/addons/:addonId',          verifyToken, ctrl.deleteAddon);

module.exports = router;
