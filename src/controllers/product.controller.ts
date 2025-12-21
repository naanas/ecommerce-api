import { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export class ProductController {
  // Public: Get All Products
  static async getAll(req: Request, res: Response) {
    const { data, error } = await supabase.from('products').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
  }

  // Seller: Create Product
  static async create(req: Request, res: Response) {
    try {
      const { name, description, price, stock, image_url } = req.body;
      
      // JURUS BYPASS: Pakai (req as any) biar tidak error TS2339
      const seller_id = (req as any).user?.id;

      const { data, error } = await supabase
        .from('products')
        .insert({ seller_id, name, description, price, stock, image_url })
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}