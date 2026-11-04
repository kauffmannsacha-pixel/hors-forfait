// Nœud TipTap « stripeRevenue » (bloc atomique déplaçable) rendu par RevenueBlockView.
import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { RevenueBlockView } from './RevenueBlock';

export const STRIPE_REVENUE_NODE = 'stripeRevenue';

export const StripeRevenue = Node.create({
  name: STRIPE_REVENUE_NODE,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() { return [{ tag: 'div[data-type="stripe-revenue"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'stripe-revenue' })]; },
  addNodeView() { return ReactNodeViewRenderer(RevenueBlockView); },
});
