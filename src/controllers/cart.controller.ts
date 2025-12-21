import { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export class CartController {
  
  // 1. Tambah ke Keranjang
  static async addToCart(req: Request, res: Response) {
    try {
      // Pakai jurus bypass (req as any) biar aman dari error TS
      const user = (req as any).user;
      
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { product_id, quantity } = req.body;

      // Cek apakah produk sudah ada di keranjang user?
      const { data: existing } = await supabase
        .from('cart_items')
        .select('*')
        .eq('user_id', user.id)
        .eq('product_id', product_id)
        .single();

      if (existing) {
        // Kalau ada, update qty (tambah yg lama dengan yg baru)
        const { error } = await supabase
          .from('cart_items')
          .update({ quantity: existing.quantity + quantity })
          .eq('id', existing.id);
          
        if (error) throw error;
      } else {
        // Kalau belum ada, insert baru
        const { error } = await supabase
          .from('cart_items')
          .insert({ 
            user_id: user.id, 
            product_id, 
            quantity 
          });
          
        if (error) throw error;
      }

      res.json({ success: true, message: 'Berhasil masuk keranjang' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 2. Lihat Isi Keranjang
  static async getCart(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      
      // Join ke tabel products untuk dapat nama, harga, gambar
      const { data, error } = await supabase
        .from('cart_items')
        .select('*, products(id, name, price, image_url, stock)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 3. Hapus Item dari Keranjang
  static async remove(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const { error } = await supabase
        .from('cart_items')
        .delete()
        .eq('id', id);

      if (error) throw error;
      
      res.json({ success: true, message: 'Item dihapus' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}