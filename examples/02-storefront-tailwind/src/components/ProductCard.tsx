// figma 1204:88 (card desktop) · 1204:131 (card mobile)
export function ProductCard({ name, price, listPrice, image }: Props) {
  return (
    <article className="flex flex-col gap-3 rounded-[10px] bg-surface p-3">
      <img src={image} alt={name} className="aspect-[3/4] w-full rounded-card object-cover" loading="lazy" />
      <h3 className="text-[15px] text-[#1a1a1a]">{name}</h3>
      <p className="flex items-baseline gap-2">
        <span className="text-price font-bold text-ink">{price}</span>
        {listPrice && <s className="text-caption text-muted">{listPrice}</s>}
      </p>
      <span className="self-start rounded-pill bg-[#d6312b] px-2 text-caption text-white">-30%</span>
    </article>
  );
}

type Props = { name: string; price: string; listPrice?: string; image: string };
