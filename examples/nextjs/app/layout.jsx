import './globals.css';

export const metadata = {
  title: 'inkfield',
  description: 'A stable-fluids simulation rendered as drifting ASCII glyphs.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
