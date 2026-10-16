begin;
-- Publish and hash-verify these assets on paddleragecdo.ph before applying.
-- Compare the original value so concurrent owner edits are never overwritten.
update public.courts set photo='https://paddleragecdo.ph/assets/venue/c1785214874684-7daf609146ce13ed.jpg' where id='c1785214874684' and md5(photo)='d14c867e54ca0d4f0ccd2b3ff1babf1c';
update public.courts set photo='https://paddleragecdo.ph/assets/venue/c1785214882952-ec3275c47d4a396d.jpg' where id='c1785214882952' and md5(photo)='6063701c3eb625eafc6bc010efe02922';
update public.courts set photo='https://paddleragecdo.ph/assets/venue/c1785214893717-d956635532581817.jpg' where id='c1785214893717' and md5(photo)='9ddd90a176e922cf2effae571aa6a982';
update public.settings set value='https://paddleragecdo.ph/assets/venue/gcash_qr_image-e06acdcd2236c3cb.jpg' where key='gcash_qr_image' and md5(value)='bde21261a6ef78745e24369f670472c0';
commit;
