import { Request, Response } from 'express';
import { supabase } from '../config/supabase'; // Pastikan di config exportnya 'const supabase'
import axios from 'axios';

// Interface Response dari Payment Orchestrator
interface OrchestratorResponse {
  success: boolean;
  data: {
    transaction_id: string;
    payment_url?: string;
    virtual_account?: string;
    qr_code?: string;
    status: string;
    amount: number;
  };
}

export class OrderController {
  
  // 1. Checkout (Bisa Banyak Barang)
  static async createOrder(req: Request, res: Response) {
    try {
      // FIX 1: Bypass type check untuk user (jika req.user belum terdeteksi TS)
      const user = (req as any).user;

      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Validasi: Pastikan user punya nomor HP
      if (!user.phone) {
        return res.status(400).json({ 
          error: 'Nomor HP wajib diisi. Mohon update profil atau register ulang dengan nomor HP.' 
        });
      }

      // FIX 2: Tambahkan 'as any' pada req.body agar 'items' terbaca
      const { items, payment_method_code } = req.body as any;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Tidak ada barang yang di-checkout' });
      }

      let totalAmount = 0;
      const orderItemsData: Array<{ product_id: any; quantity: any; price_at_purchase: any }> = [];

      // A. Validasi Stok & Hitung Total Harga
      // FIX 3: Berikan tipe 'any' pada item loop biar aman
      for (const item of (items as any[])) {
        const { data: product } = await supabase
          .from('products')
          .select('*')
          .eq('id', item.product_id)
          .single();
        
        if (!product) {
          return res.status(404).json({ error: `Produk dengan ID ${item.product_id} tidak ditemukan` });
        }

        if (product.stock < item.quantity) {
          return res.status(400).json({ error: `Stok tidak cukup untuk produk: ${product.name}` });
        }

        totalAmount += product.price * item.quantity;
        
        // Siapkan data untuk dimasukkan ke tabel order_items nanti
        orderItemsData.push({
          product_id: product.id,
          quantity: item.quantity,
          price_at_purchase: product.price
        });
      }

      // B. Buat Order Header (Status PENDING)
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          buyer_id: user.id,
          total_amount: totalAmount,
          status: 'PENDING'
        })
        .select()
        .single();

      if (orderError) throw orderError;

      // C. Masukkan Order Items (Batch Insert)
      const itemsToInsert = orderItemsData.map(i => ({
        ...i,
        order_id: order.id
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // D. Hapus item dari Keranjang User
      // PASTIKAN KAMU SUDAH JALANKAN SQL CREATE TABLE 'cart_items' DI SUPABASE
      await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', user.id);

      // E. Integrasi Payment Orchestrator
      try {
        const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
        if (!orchestratorUrl) throw new Error('Orchestrator URL not configured');

        const payload = {
          amount: totalAmount,
          payment_method: payment_method_code || 'BCA_VA',
          customer_name: user.name,
          customer_email: user.email,
          customer_phone: user.phone,
          description: `Order ShopeeClone #${order.id.substring(0, 8)}`
        };

        const orchestratorResponse = await axios.post<OrchestratorResponse>(
          `${orchestratorUrl}/payments/create`, 
          payload
        );

        const paymentData = orchestratorResponse.data.data;
        
        // Update Order Lokal dengan Transaction ID dari Orchestrator
        await supabase
          .from('orders')
          .update({
            payment_id: paymentData.transaction_id,
          })
          .eq('id', order.id);

        res.json({
          success: true,
          data: {
            order_id: order.id,
            total_amount: totalAmount,
            status: 'PENDING',
            payment_details: paymentData
          }
        });

      } catch (paymentError: any) {
        console.error("Payment Error:", paymentError.response?.data || paymentError.message);
        // Tetap return sukses 201 karena Order Lokal sudah terbuat
        res.status(201).json({ 
            success: true,
            message: "Order created but payment initiation failed",
            data: { order } 
        });
      }

    } catch (error: any) {
      console.error("Create Order Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }

  // 2. Webhook Handler
  static async handleWebhook(req: Request, res: Response) {
    try {
      const { transaction_id, status } = req.body;

      console.log(`🔔 Webhook received for ${transaction_id}: ${status}`);

      if (!transaction_id || !status) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      // Cari order berdasarkan payment_id
      const { data: order } = await supabase
        .from('orders')
        .select('id')
        .eq('payment_id', transaction_id)
        .single();

      if (!order) {
        console.warn(`Order not found for transaction: ${transaction_id}`);
        return res.status(404).json({ error: 'Order not found' });
      }

      // Update status order
      const { error } = await supabase
        .from('orders')
        .update({ status: status })
        .eq('id', order.id);

      if (error) throw error;

      res.json({ success: true, message: 'Order status updated' });

    } catch (error: any) {
      console.error("Webhook Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }

  // 3. Get My Orders
  static async getMyOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*, products(name, price, image_url))')
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}