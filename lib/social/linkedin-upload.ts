const LI_API = "https://api.linkedin.com/v2";

export async function uploadImage(opts: {
  accessToken: string;
  ownerUrn: string;
  imageBuffer: ArrayBuffer;
}): Promise<string> {
  const { accessToken, ownerUrn, imageBuffer } = opts;

  // Step 1: Register the upload
  const registerRes = await fetch(`${LI_API}/assets?action=registerUpload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        owner: ownerUrn,
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        serviceRelationships: [
          { identifier: "urn:li:userGeneratedContent", relationshipType: "OWNER" },
        ],
        supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
      },
    }),
  });

  if (!registerRes.ok) {
    const err = await registerRes.text();
    throw new Error(`LinkedIn registerUpload failed (${registerRes.status}): ${err}`);
  }

  const registerData = await registerRes.json() as {
    value: {
      asset: string;
      uploadMechanism: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
          uploadUrl: string;
        };
      };
    };
  };

  const uploadUrl =
    registerData.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const assetUrn = registerData.value.asset;

  // Step 2: Upload the image bytes
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "image/jpeg",
    },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`LinkedIn image upload failed (${uploadRes.status}): ${err}`);
  }

  return assetUrn;
}
