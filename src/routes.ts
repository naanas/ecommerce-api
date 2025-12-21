import { Router } from 'express';
import { AuthController } from './controllers/auth.controller';
import { ProductController } from './controllers/product.controller';
import { OrderController } from './controllers/order.controller';
import { CartController } from './controllers/cart.controller'; // Import Controller Cart
import { authMiddleware, requireRole } from './middleware/auth';

const router = Router();

// ================= AUTH ROUTES =================
router.post('/auth/register', AuthController.register);
router.post('/auth/login', AuthController.login);

// ================= PRODUCT ROUTES =================
// Public: Semua orang bisa lihat produk
router.get('/products', ProductController.getAll); 
router.get('/products/:id', ProductController.getOne);


// Protected Seller Routes
router.get('/seller/products', authMiddleware, requireRole(['SELLER']), ProductController.getMyProducts);
router.post('/products', authMiddleware, requireRole(['SELLER']), ProductController.create);
router.put('/products/:id', authMiddleware, requireRole(['SELLER']), ProductController.update); // Update
router.delete('/products/:id', authMiddleware, requireRole(['SELLER']), ProductController.delete); // Delete

// Private: Cuma Seller yang bisa tambah produk
router.post(
  '/products', 
  authMiddleware, 
  requireRole(['SELLER', 'ADMIN']), 
  ProductController.create
);

// ================= CART ROUTES (BARU) =================
// Semua fitur keranjang butuh login (authMiddleware)
router.get('/cart', authMiddleware, CartController.getCart);           // Lihat isi keranjang
router.post('/cart', authMiddleware, CartController.addToCart);        // Tambah ke keranjang
router.delete('/cart/:id', authMiddleware, CartController.remove);     // Hapus item dari keranjang

// ================= ORDER ROUTES =================
// Buyer: Checkout (Sekarang support banyak barang dari keranjang)
router.post(
  '/orders', 
  authMiddleware, 
  requireRole(['BUYER','SELLER']), 
  OrderController.createOrder
);

// Buyer: Lihat Riwayat Belanja
router.get(
  '/orders/my', 
  authMiddleware, 
  requireRole(['BUYER','SELLER']), 
  OrderController.getMyOrders
);

// ================= WEBHOOK ROUTE =================
// Endpoint ini ditembak oleh Payment Orchestrator (Server-to-Server)
// Tidak butuh auth user (Public endpoint), tapi nanti bisa diamankan dengan secret key di header
router.post('/webhook/payment', OrderController.handleWebhook);

export default router;