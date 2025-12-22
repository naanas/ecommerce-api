import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
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
  
  // 1. Checkout (Create Order, Validasi Stok, Anti-Self-Buy, Payment Integration)
  static async createOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'User not authenticated' });

      // Validasi No HP
      if (!user.phone) {
        return res.status(400).json({ 
          error: 'Nomor HP wajib diisi. Mohon update profil.' 
        });
      }

      const { items, payment_method_code } = req.body as any;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Tidak ada barang yang di-checkout' });
      }

      let totalAmount = 0;
      const orderItemsData: any[] = [];
      const productsToUpdate: any[] = [];

      // ==========================================================
      // TAHAP 1: VALIDASI (STOK, HARGA & SELF-BUY)
      // ==========================================================
      for (const item of (items as any[])) {
        const { data: product } = await supabase
          .from('products')
          .select('*')
          .eq('id', item.product_id)
          .single();
        
        if (!product) {
          return res.status(404).json({ error: `Produk ID ${item.product_id} tidak ditemukan` });
        }

        // 🔥 Validasi: Tidak boleh beli barang sendiri
        if (product.seller_id === user.id) {
          return res.status(400).json({ 
            error: `Ups! Anda tidak bisa membeli produk sendiri: ${product.name}` 
          });
        }

        // Cek Stok
        if (product.stock < item.quantity) {
          return res.status(400).json({ error: `Stok habis untuk produk: ${product.name}` });
        }

        totalAmount += product.price * item.quantity;
        
        orderItemsData.push({
          product_id: product.id,
          quantity: item.quantity,
          price_at_purchase: product.price
        });

        productsToUpdate.push({
          id: product.id,
          newStock: product.stock - item.quantity
        });
      }

      // ==========================================================
      // TAHAP 2: SIMPAN ORDER KE DATABASE E-COMMERCE
      // ==========================================================
      
      // 2a. Buat Header Order
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

      // 2b. Buat Order Items
      const itemsToInsert = orderItemsData.map(i => ({
        ...i,
        order_id: order.id
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // 2c. Potong Stok Produk
      for (const prod of productsToUpdate) {
        await supabase
          .from('products')
          .update({ stock: prod.newStock })
          .eq('id', prod.id);
      }

      // 2d. Bersihkan Keranjang
      await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', user.id);

      // ==========================================================
      // TAHAP 3: INTEGRASI PAYMENT ORCHESTRATOR (UPDATED 🔥)
      // ==========================================================
      try {
        const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
        const serverKey = process.env.PAYMENT_SERVER_KEY; // 👈 Pastikan ada di .env

        if (!orchestratorUrl || !serverKey) {
            throw new Error('Payment Config (URL/Key) missing in .env');
        }

        const payload = {
          amount: totalAmount,
          payment_method: payment_method_code || 'BCA_VA',
          customer_name: user.name,
          customer_email: user.email,
          customer_phone: user.phone,
          reference_id: order.id,
          description: `Order #${order.id.substring(0, 8)}`
        };

        // 🔥 BAGIAN PENTING: TAMBAHKAN HEADERS DISINI 🔥
        const orchestratorResponse = await axios.post<OrchestratorResponse>(
          `${orchestratorUrl}/payments/create`, 
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'x-server-key': serverKey
            }
          }
        );

        const paymentData = orchestratorResponse.data.data;
        
        // Update Order dengan Transaction ID dari Orchestrator
        await supabase
          .from('orders')
          .update({ payment_id: paymentData.transaction_id })
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
        
        // Tetap return sukses create order walau payment gagal inisiasi
        // (Supaya user tidak panik dan bisa coba bayar ulang nanti, walau logic re-pay belum ada)
        res.status(201).json({ 
            success: true,
            message: "Order created but payment initiation failed. Please contact admin.",
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

      if (!transaction_id || !status) return res.status(400).json({ error: 'Invalid payload' });

      // Cari order berdasarkan payment_id
      const { data: order } = await supabase
        .from('orders')
        .select('id')
        .eq('payment_id', transaction_id)
        .single();

      if (!order) return res.status(404).json({ error: 'Order not found' });

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
        .select('*, order_items(*, products(*))') // Pastikan payment_id ikut terambil
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}