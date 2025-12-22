import { Request, Response } from 'express';
import { supabase } from '../config/supabase'; // Sesuaikan path config supabase kamu
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
  
  // =================================================================
  // 1. CREATE ORDER (Checkout)
  // =================================================================
  static async createOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      
      // 1. Validasi Auth
      if (!user) return res.status(401).json({ error: 'User not authenticated' });
      if (!user.phone) {
        return res.status(400).json({ error: 'Nomor HP wajib diisi. Mohon update profil.' });
      }

      const { items, payment_method_code } = req.body as any;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Tidak ada barang yang di-checkout' });
      }

      // 2. Variable untuk kalkulasi
      let totalAmount = 0;
      const orderItemsData: any[] = [];
      const productsToUpdate: any[] = [];

      // ==========================================================
      // TAHAP 1: VALIDASI STOK, HARGA & SELF-BUY
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

        // Validasi: Tidak boleh beli barang sendiri
        if (product.seller_id === user.id) {
          return res.status(400).json({ error: `Anda tidak bisa membeli produk sendiri: ${product.name}` });
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
      // TAHAP 2: DATABASE TRANSACTION (SIMPAN ORDER)
      // ==========================================================
      
      // 2a. Buat Header Order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          buyer_id: user.id,
          total_amount: totalAmount,
          status: 'PENDING'
          // payment_id masih NULL di sini
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
      // TAHAP 3: INTEGRASI PAYMENT ORCHESTRATOR (PERBAIKAN DISINI)
      // ==========================================================
      try {
        const orchestratorUrl = process.env.PAYMENT_ORCHESTRATOR_URL;
        const serverKey = process.env.PAYMENT_SERVER_KEY;

        if (!orchestratorUrl || !serverKey) {
            throw new Error('Konfigurasi Payment (URL/Key) hilang di .env');
        }

        // PERHATIKAN INI: Pastikan tidak double slash //
        // Jika orchestratorUrl = 'https://abc.com', maka hasilnya 'https://abc.com/api/payments'
        // Sesuaikan '/api/payments' dengan route asli di Orchestrator lu.
        const endpoint = `${orchestratorUrl.replace(/\/$/, '')}/api/payments/create`;

        const payload = {
          order_id: order.id, // Sesuaikan field yg diminta orchestrator (order_id/reference_id?)
          amount: totalAmount,
          payment_method: payment_method_code || 'BCA_VA', // Default payment
          customer_name: user.name || 'Pelanggan',
          customer_email: user.email,
          customer_phone: user.phone,
          description: `Order #${order.id.substring(0, 8)}`
        };

        console.log(`[BACKEND] Request ke Orchestrator: ${endpoint}`);

        const orchestratorResponse = await axios.post<OrchestratorResponse>(
          endpoint, 
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

        // SUKSES SEMPURNA
        res.status(201).json({
          success: true,
          data: {
            order_id: order.id,
            total_amount: totalAmount,
            status: 'PENDING',
            payment_id: paymentData.transaction_id,
            payment_details: paymentData
          }
        });

      } catch (paymentError: any) {
        // LOG ERROR UNTUK DEBUGGING DI VERCEL
        console.error("!!! GAGAL MENGHUBUNGI ORCHESTRATOR !!!");
        if (paymentError.response) {
            console.error("Status:", paymentError.response.status);
            console.error("Response:", paymentError.response.data);
        } else {
            console.error("Error:", paymentError.message);
        }
        
        // RETURN PARTIAL SUCCESS
        // Kita return success: FALSE, tapi kasih data ordernya.
        // Ini supaya frontend tau ordernya jadi, tapi paymentnya error.
        res.status(201).json({ 
            success: false, // FLAG PENTING: Supaya frontend tidak munculin alert sukses sembarangan
            message: "Order berhasil dibuat di database, namun gagal menginisiasi pembayaran. Silakan cek menu Pesanan.",
            data: { 
                order_id: order.id,
                status: 'PENDING',
                payment_id: null 
            } 
        });
      }

    } catch (error: any) {
      console.error("Create Order Fatal Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  }

  // =================================================================
  // 2. WEBHOOK HANDLER
  // =================================================================
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

  // =================================================================
  // 3. GET MY ORDERS
  // =================================================================
  static async getMyOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*, products(*))') 
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}