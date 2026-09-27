import { searchTerms } from "../shared/search-excerpt";

export function SearchExcerpt({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const words = searchTerms(query).sort((a, b) => b.length - a.length);
  if (!words.length) return <>{text}</>;
  const expression = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  return (
    <>
      {text
        .split(expression)
        .map((part, i) =>
          words.includes(part.toLowerCase()) ? (
            <mark key={i}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}
