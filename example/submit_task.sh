jwt=`cat ~/.sca/keys/cli.jwt`

curl \
    -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" \
    -X POST https://soichi7.ppa.iu.edu/api/sca/task -d '
{
    "instance_id": "570d1ef166a1e2fc1ef5a847",
    "service": "soichih/sca-service-neuro-tracking",
    "config": {
        "nii_gz": "/N/dc2/scratch/hayashis/lifebid/110411/diffusion_data/dwi_data_b3000_aligned_trilin.nii.gz",
        "dwi_b": "/N/dc2/scratch/hayashis/lifebid/110411/outdir/dwi_data_b3000_aligned_trilin.b",
        "mask_nii_gz": "/N/dc2/scratch/hayashis/lifebid/110411/anatomy/wm_mask.nii.gz",
        "lmax": [2,4,6],
        "tracks": 10,
        "fibers": 5000,
        "fibers_max_attempted": 10000
    }
}'
