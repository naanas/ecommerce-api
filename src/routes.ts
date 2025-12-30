import { Router } from 'express';
import { AuthController } from './controllers/auth.controller';
import { ProductController } from './controllers/product.controller';
import { OrderController } from './controllers/order.controller';
import { CartController } from './controllers/cart.controller';
import { PaymentController } from './controllers/payment.controller'; // [BARU] Import PaymentController
import { authMiddleware, requireRole } from './middleware/auth';

const router = Router();

// ================= AUTH ROUTES =================
router.post('/auth/register', AuthController.register);
router.post('/auth/login', AuthController.login);

// ================= PRODUCT ROUTES =================
// Public
router.get('/products', ProductController.getAll); 
router.get('/products/:id', ProductController.getOne);

// Protected Seller Routes
router.get('/seller/products', authMiddleware, requireRole(['SELLER']), ProductController.getMyProducts);
router.put('/products/:id', authMiddleware, requireRole(['SELLER']), ProductController.update);
router.delete('/products/:id', authMiddleware, requireRole(['SELLER']), ProductController.delete);

// Private: Create Product
router.post(
  '/products', 
  authMiddleware, 
  requireRole(['SELLER', 'ADMIN']), 
  ProductController.create
);

// ================= CART ROUTES =================
router.get('/cart', authMiddleware, CartController.getCart);
router.post('/cart', authMiddleware, CartController.addToCart);
router.delete('/cart/:id', authMiddleware, CartController.remove);

// ================= ORDER ROUTES =================
router.post(
  '/orders', 
  authMiddleware, 
  requireRole(['BUYER','SELLER']), 
  OrderController.createOrder
);

router.get(
  '/orders/my', 
  authMiddleware, 
  requireRole(['BUYER','SELLER']), 
  OrderController.getMyOrders
);

// ================= PAYMENT ROUTES (BARU) =================
// Endpoint ini ditembak oleh Frontend untuk cek admin fee
router.get('/payment/fee', authMiddleware, PaymentController.getPaymentFee);


// ================= WEBHOOK ROUTE =================
router.post('/webhook/payment', OrderController.handleWebhook);

export default router;