import { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export class ProductController {
  
  // 1. Get All Public (Untuk Halaman Home)
  static async getAll(req: Request, res: Response) {
    try {
      // Ambil produk yang stoknya > 0 atau tampilkan semua terserah kebijakan
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 2. Get My Products (KHUSUS SELLER DASHBOARD)
  static async getMyProducts(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('seller_id', user.id) // Filter by Seller ID
        .order('created_at', { ascending: false });

      if (error) throw error;
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 3. Get Single Product (Untuk Edit Form)
  static async getOne(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .single();
        
      if (error || !data) return res.status(404).json({ error: 'Produk tidak ditemukan' });
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 4. Create Product (Simpan seller_id)
  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user; // Dari middleware auth
      const { name, description, price, stock, image_url } = req.body;

      const { data, error } = await supabase
        .from('products')
        .insert({
          seller_id: user.id, // PENTING: Simpan ID Seller
          name, description, price, stock, image_url
        })
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ success: true, message: 'Produk berhasil dibuat', data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 5. Update Product
  static async update(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      const updates = req.body;

      // Pastikan yang update adalah pemilik produk
      const { error } = await supabase
        .from('products')
        .update(updates)
        .eq('id', id)
        .eq('seller_id', user.id); // Security check

      if (error) throw error;
      res.json({ success: true, message: 'Produk berhasil diupdate' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // 6. Delete Product
  static async delete(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { id } = req.params;

      const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', id)
        .eq('seller_id', user.id); // Security check

      if (error) throw error;
      res.json({ success: true, message: 'Produk dihapus' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}